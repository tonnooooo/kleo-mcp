/**
 * KLEO STUDIO — THE ADMIN CONSOLE'S API (23 October 2026, the owner: "una pagina admin, con tutto quanto in modo da
 * gestire tutto … ma una roba fatta bene e professionale"). The page is app.kleooai.com/admin (studio-web/admin.js).
 *
 * Who: only the accounts in STUDIO_ADMINS. The router (src/studio/index.ts) checks the session cookie server-side,
 * answers 404 to anybody else, and wants the X-Kleo header on every call here, reads included (the same CSRF guard as
 * every other write of the app: a cross-site page cannot add the header without a preflight, and none is answered).
 * Then the console's own sign-in (src/studio/admin-auth.ts): a code from the owner's phone opens a separate admin
 * session, and the dangerous writes want a code typed in the last 5 minutes.
 *
 *   /api/admin/auth/*                         the console's sign-in, set-up and sign-out (admin-auth.ts)
 *   GET  /api/admin/security                  the console's sign-ins, the account's sign-in methods, recovery codes left
 *
 *   GET  /api/admin/overview                 accounts, money in, provider spend, budgets, the newest of each
 *   GET  /api/admin/users?q&filter&sort&dir  every account, searchable and sortable
 *   GET  /api/admin/users/:id                one account: profile, payments, creations, audit, sign-ins, addresses
 *   POST /api/admin/users/:id/credits        {delta, reason}                add or take away credits
 *   POST /api/admin/users/:id/gift           {id, credits, reason, message?, email}   a gift from the Kleo team: the
 *                                            credits at once (the same path as credits), a pop-up in the app, the e-mail if
 *                                            asked; an id already given is answered as it is, nothing moves twice
 *   POST /api/admin/users/:id/gifts/:gift/mail   {}                         a gift's e-mail again, when it is waiting
 *   POST /api/admin/users/:id/gifts/:gift/cancel {reason, takeBack?, code?} a gift not seen yet, cancelled: its pop-up
 *                                            never shown, and its credits back (up to the balance) unless takeBack is false
 *   POST /api/admin/users/:id/block          {on, reason}                   close or reopen the account
 *   POST /api/admin/users/:id/address        {on, reason, days?, hash?}     block or free the address it signs in from
 *   POST /api/admin/users/:id/key            {reason}                       a new Kleo key (assistants disconnected)
 *   POST /api/admin/users/:id/signout        {reason}                       every session ends
 *   POST /api/admin/users/:id/delete         {reason, confirm: "DELETE"}    the account's data deleted for good
 *   POST /api/admin/users/:id/ip-lookup      {audit}                        the address of a past event, from Cloudflare
 *   GET  /api/admin/payments?status          every payment, totals by day and month, Stripe links
 *   GET  /api/admin/generations?status&kind&user&before    the newest creations of every account, with previews
 *   GET  /api/admin/failures?days            failed creations grouped by reason and provider
 *   GET  /api/admin/spend?days               what each account cost in provider dollars, next to what it paid
 *   GET  /api/admin/providers                which secrets are set (names only), live balances, the settings
 *   GET  /api/admin/sources?days             where accounts came from: per network and per short link, first visits,
 *                                            clicks, sign-ups, accounts that made something, paying accounts, money
 *   POST /api/admin/sources/links            {channel, label, target?, code?}   a new short link (app.kleooai.com/r/<code>)
 *   POST /api/admin/sources/links/:code      {label?, target?, archived?}      change or hide one
 *   GET  /api/admin/emails                   the welcome e-mails: the switch, what was sent, what comes next, who the
 *                                            comeback e-mail would reach if they went on now (src/studio/onboarding.ts)
 *   GET  /api/admin/emails/preview?key       one e-mail as a sample account would get it
 *   POST /api/admin/emails/mode              {on, code?}                    switch them on (a fresh code) or off
 *   POST /api/admin/emails/test              {}                             every e-mail to the owner's own inbox
 *   POST /api/admin/emails/suppress          {email, on}                    stop (or allow again) one address
 *   POST /api/admin/emails/receipts          {on}                           the payment e-mails on or off (receipts.ts)
 *   GET  /api/admin/outreach                 outreach: the switch, the mailboxes (never a password), warm-up, settings,
 *                                            counts, sign-ups, the versions' replies, the scout, the last sends and replies
 *   GET  /api/admin/outreach/prospects?status&q&offset    the businesses, 60 at a time
 *   GET  /api/admin/outreach/preview?id      every e-mail one prospect would get (src/studio/outreach.ts)
 *   POST /api/admin/outreach/senders         {id?, fromName, fromAddr, user, smtpHost, smtpPort, imapHost, imapPort,
 *                                            dailyMax, password?, code}   a mailbox, kept only once SMTP and IMAP sign in
 *   POST /api/admin/outreach/senders/:id     {action: on|off|remove}
 *   POST /api/admin/outreach/settings        {postal?, trialCredits?, autoReply?, autoApprove?, scoutOn?, scoutDaily?, code?}
 *   POST /api/admin/outreach/mode            {on, code?}                    on needs everything ready and a fresh code
 *   POST /api/admin/outreach/test            {sender?, to?, step?}          a sample e-mail (step 0, 1, 2) to the mailbox itself, or to `to`
 *   POST /api/admin/outreach/prospects/:id   {action: approve|reject|reset}
 *   POST /api/admin/outreach/approve-new     {}                             every prospect still waiting
 *   POST /api/admin/outreach/import          {csv, batch}                   more prospects, checked like the first
 *   GET  /api/admin/creators                 Kleo Creators: applications, creators, posts to read at day 7, cash due
 *   GET  /api/admin/creators/:id             one creator: application, checks, posts, commissions, payouts, program credits
 *   POST /api/admin/creators/:id/:action     {reason, …}  bio | approve {level?} | refuse | level {level} | end | ban |
 *                                            reopen | note {note} | credits {credits} | payout {method, ref}
 *   POST /api/admin/creators/posts/:id       {action: approve, views} | {action: reject, reason}   (src/studio/creators.ts)
 *
 * EVERY WRITE IS AUDITED: one `admin.*` row on the account it touched, with the admin's id and the reason typed.
 * Previews are signed links valid one hour (session.ts signPath): the admin is not the owner of the files.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { ipFingerprint, rotateKey } from "../accounts.ts";
import { blockAddress } from "../abuse.ts";
import { EPHONE_NO_MONEY_RE } from "../ephone.ts";
import { APIMART_NO_MONEY_RE } from "../apimart.ts";
import { isAdmin, parseSlots, StudioError } from "./generate.ts";
import { deleteAccount, endAllSessions, endMergedSessions } from "./auth.ts";
import { signPath } from "./session.ts";
import { studioSpentTodayUsd, type GenerationRow, type Slot } from "./store.ts";
import { balances, secretStatus } from "./admin-providers.ts";
import { KLEO_ZONE, lookupRequests, pathsFor } from "./ip-lookup.ts";
import { IP_RETENTION_DAYS } from "./ips.ts";
import { adminAuthApi, adminSessionOf, checkFreshCode, FRESH_MIN, isFresh, securityInfo, touchSession, type AdminSession } from "./admin-auth.ts";
import { keyAction, listKeys } from "./admin-keys.ts";
import { CODE_RE, LINK_CHANNELS, getLink, type LinkChannel, type LinkRow } from "./attribution.ts";
import { addProspects, listProspects, outreachOverview, parseCsv, previewFor, prospectAction, saveSender, saveSettings, sendOutreachTest, senderAction, setOutreachMode } from "./outreach.ts";
import { RECEIPT_KINDS, composeReceipt, receiptsOn, sampleReceipt } from "./receipts.ts";
import { adminCreator, adminCreatorAction, adminCreators, adminPostAction } from "./creators.ts";
import { ALL_MAILS, SERIES, comebackMail, compose, factsOf, livePrices, mailMode, renderHtml, renderText, sampleFacts, sendSeriesToOwner, setMailMode, type MailKey } from "./onboarding.ts";
import { GIFT_ID, GIFT_MAIL_NAME, composeGift, giftAddress, giftById, giftInsert, giftMessage, giftsOf, mailGift, mailGiftAgain, sampleGift, type GiftDraft, type GiftMail, type GiftRow } from "./gifts.ts";
import { rid } from "../util.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const TODAY = "strftime('%Y-%m-%dT00:00:00.000Z','now')";
const ago = (days: number) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${Math.max(0, Math.floor(days))} days')`;
const PREVIEW_TTL = 3600;
const LOOKUPS_PER_HOUR = 30;

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { throw new StudioError("Bad request."); }
}
const int = (v: unknown, d: number, lo: number, hi: number): number => {
  if (v === null || v === undefined || v === "") return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** The reason every write needs, as the audit row keeps it. */
export function reasonOf(b: Record<string, unknown>): string {
  const r = String(b.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (r.length < 3) throw new StudioError("Write a short reason first: it is kept in the audit log.", 400, "reason");
  return r;
}

// ── accounts ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The address a person is known by: a sign-in's, the account's own (unless synthetic), the contact one, Stripe's. */
const EMAIL_SQL = `COALESCE((SELECT l.email FROM studio_logins l WHERE l.user_id = u.id AND l.email IS NOT NULL ORDER BY l.created_at LIMIT 1),
  CASE WHEN u.email LIKE '%.invalid' THEN NULL ELSE u.email END, u.contact_email,
  (SELECT p.email FROM payments p WHERE p.user_id = u.id AND p.email IS NOT NULL ORDER BY p.at DESC LIMIT 1))`;
const LAST_IP = (col: string) => `(SELECT i.${col} FROM studio_ips i WHERE i.user_id = u.id ORDER BY i.at DESC, i.id DESC LIMIT 1)`;

/** One account as the list shows it; every column a sort or a search may need. */
const USER_COLS = `u.id, u.display_name AS name, u.credits, u.plan, u.plan_period, u.plan_until, u.plan_status, u.created_at, u.src,
  u.merged_into, u.blocked_at, u.ip_hash, ${EMAIL_SQL} AS email,
  CASE WHEN u.email LIKE '%@deleted.kleo.invalid' THEN 1 ELSE 0 END AS deleted,
  CASE WHEN u.email LIKE '%@anon.kleo.invalid' AND NOT EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = u.id) THEN 1 ELSE 0 END AS anonymous,
  (SELECT GROUP_CONCAT(l.provider) FROM studio_logins l WHERE l.user_id = u.id) AS methods,
  (SELECT COALESCE(SUM(p.amount_cent), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cent > 0) AS paid_cent,
  (SELECT MAX(p.currency) FROM payments p WHERE p.user_id = u.id AND p.amount_cent > 0) AS currency,
  (SELECT COUNT(*) FROM studio_generations g WHERE g.user_id = u.id) AS gens,
  (SELECT COALESCE(SUM(g.est_usd), 0) FROM studio_generations g WHERE g.user_id = u.id AND g.status != 'failed') AS spend_usd,
  ${LAST_IP("ip")} AS ip, ${LAST_IP("city")} AS city, ${LAST_IP("region")} AS region,
  COALESCE(${LAST_IP("country")}, (SELECT p.country FROM payments p WHERE p.user_id = u.id AND p.country IS NOT NULL LIMIT 1)) AS country,
  NULLIF(MAX(COALESCE(u.last_seen_at, ''), COALESCE((SELECT MAX(l.last_login_at) FROM studio_logins l WHERE l.user_id = u.id), ''),
    COALESCE((SELECT MAX(g.created_at) FROM studio_generations g WHERE g.user_id = u.id), ''),
    COALESCE((SELECT MAX(i.at) FROM studio_ips i WHERE i.user_id = u.id), ''),
    COALESCE((SELECT MAX(c.updated_at) FROM studio_chats c WHERE c.user_id = u.id), '')), '') AS last_seen`;

const SORTS: Record<string, string> = {
  created: "created_at", seen: "last_seen", credits: "credits", paid: "paid_cent", spend: "spend_usd", gens: "gens",
  name: "COALESCE(name, email, id) COLLATE NOCASE",
};
const FILTERS: Record<string, string> = {
  all: "1", paid: "paid_cent > 0", free: "paid_cent = 0 AND deleted = 0", blocked: "blocked_at IS NOT NULL",
  new: `created_at >= ${ago(7)}`, deleted: "deleted = 1",
};
// ?1 = the search as a LIKE pattern, ?2 = the search as typed (null: no search).
const SEARCH = `(?2 IS NULL OR x.id LIKE ?1 OR x.email LIKE ?1 OR x.name LIKE ?1 OR x.city LIKE ?1 OR x.country = ?2 COLLATE NOCASE
  OR EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = x.id AND (l.email LIKE ?1 OR l.subject = ?2))
  OR EXISTS (SELECT 1 FROM studio_ips i WHERE i.user_id = x.id AND (i.ip LIKE ?1 OR i.city LIKE ?1))
  OR EXISTS (SELECT 1 FROM payments p WHERE p.user_id = x.id AND (p.email LIKE ?1 OR p.payment_intent = ?2 OR p.session_id = ?2))
  OR EXISTS (SELECT 1 FROM users u2 WHERE u2.id = x.id AND (u2.email LIKE ?1 OR u2.contact_email LIKE ?1)))`;

async function listUsers(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const filter = FILTERS[url.searchParams.get("filter") ?? "all"] ?? FILTERS.all;
  const sortKey = SORTS[url.searchParams.get("sort") ?? ""] ? url.searchParams.get("sort")! : "created";
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  const limit = int(url.searchParams.get("limit"), 50, 1, 200), offset = int(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = `${SEARCH.replace(/LIKE \?1/g, "LIKE ?1 ESCAPE '\\'")} AND (${filter})`;
  const inner = `SELECT ${USER_COLS} FROM users u`;
  const col = SORTS[sortKey];
  const rows = (await env.DB.prepare(`SELECT * FROM (${inner}) x WHERE ${where} ORDER BY (${col}) IS NULL, ${col} ${dir}, x.id LIMIT ?3 OFFSET ?4`)
    .bind(like, q || null, limit, offset).all<Record<string, unknown>>()).results;
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${inner}) x WHERE ${where}`).bind(like, q || null).first<{ n: number }>())?.n ?? 0;
  return { users: rows.map((r) => ({ ...r, admin: isAdmin(env, String(r.id)) })), total, offset, limit, sort: sortKey, dir: dir.toLowerCase() };
}

/** Where a creation was made: its slots' provider, the prefix of its task id ("apimart:…"), or ePhone. */
export function providerOf(g: Pick<GenerationRow, "kind" | "task_id" | "slots">, slots: Slot[] = parseSlots(g)): string {
  if (g.kind === "film") return "kleo-mcp";
  const p = slots.find((s) => s.provider)?.provider;
  if (p) return p;
  return /^(apimart|wavespeed):/.exec(g.task_id ?? "")?.[1] ?? "ephone";
}

/** A creation as the console shows it, with signed links to its files. */
async function adminGen(env: StudioEnv, g: GenerationRow & { email?: string | null }): Promise<Record<string, unknown>> {
  const slots = parseSlots(g);
  let s: Record<string, unknown> = {};
  try { s = JSON.parse(g.settings) ?? {}; } catch { /* keep {} */ }
  const outputs: { type: string; url: string }[] = [];
  if ((g.kind === "video" || g.kind === "film" || !g.kind) && g.status === "done" && g.file_key) {
    outputs.push({ type: "video", url: await signPath(env.INTERNAL_SECRET, `/media/${g.id}.mp4`, PREVIEW_TTL) });
  } else {
    for (const x of slots.filter((x) => x.status === "done" && x.upload).slice(0, 4)) {
      outputs.push({ type: x.type ?? "image", url: await signPath(env.INTERNAL_SECRET, `/media/u/${x.upload}`, PREVIEW_TTL) });
    }
  }
  const pick = (k: string) => (s[k] === undefined || s[k] === null ? undefined : s[k]);
  return {
    id: g.id, user_id: g.user_id, email: g.email ?? undefined, kind: g.kind ?? "video", model: g.model, status: g.status,
    credits: g.credits, est_usd: g.est_usd, refunded: !!g.refunded, error: g.error, prompt: String(g.prompt ?? "").slice(0, 400),
    created_at: g.created_at, finished_at: g.finished_at, provider: providerOf(g, slots), outputs,
    settings: { resolution: pick("resolution"), duration: pick("duration"), aspect: pick("aspect"), quality: pick("quality"), count: pick("count"), tool: pick("tool") },
  };
}

async function userDetail(env: StudioEnv, id: string): Promise<Record<string, unknown>> {
  const user = await env.DB.prepare(`SELECT ${USER_COLS}, u.email AS account_email, u.contact_email, u.key_version, u.studio_epoch, u.gift,
      u.blocked_reason, u.plan_sub, u.plan_customer, u.plan_credits, u.plan_next_grant, u.studio_auto_wan AS auto_wan FROM users u WHERE u.id = ?`)
    .bind(id).first<Record<string, unknown>>();
  if (!user) throw new StudioError("No account with that id.", 404, "not_found");
  const all = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
  const [logins, payments, gens, jobs, events, ips, merged] = await Promise.all([
    all("SELECT provider, subject, email, created_at, last_login_at FROM studio_logins WHERE user_id = ? ORDER BY created_at", id),
    all("SELECT session_id, credits, amount_cent, currency, email, payment_intent, status, country, event_type, at FROM payments WHERE user_id = ? ORDER BY at DESC", id),
    all<GenerationRow>("SELECT * FROM studio_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 300", id),
    all("SELECT id, template, state, credits, cost_usd, error, created_at, finished_at FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", id),
    all("SELECT id, at, event, job_id, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 300", id),
    all(`SELECT id, at, event, ip, ip_hash, country, region, city, asn, as_org, ua FROM studio_ips WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 200`, id),
    all("SELECT id FROM users WHERE merged_into = ?", id),
  ]);
  // The address it signed up from: its block, and the other accounts opened from it.
  const hash = (user.ip_hash as string | null) ?? null;
  const hashes = [...new Set([hash, ...ips.map((r) => r.ip_hash as string | null)].filter((h): h is string => !!h))].slice(0, 20);
  const blocks = hashes.length
    ? await all(`SELECT ip_hash, reason, until, created_at FROM blocked_addresses WHERE ip_hash IN (${hashes.map(() => "?").join(",")}) AND until > ${NOW}`, ...hashes)
    : [];
  const twins = hash ? await all(`SELECT u.id, ${EMAIL_SQL} AS email, u.created_at FROM users u WHERE u.ip_hash = ? AND u.id != ? ORDER BY u.created_at DESC LIMIT 20`, hash, id) : [];
  const redemption = await env.DB.prepare("SELECT code, channel, credits, film_job, at FROM redemptions WHERE user_id = ?").bind(id).first().catch(() => null);
  const paid = await all("SELECT currency, SUM(amount_cent) AS cents FROM payments WHERE user_id = ? AND status = 'paid' AND amount_cent > 0 GROUP BY currency", id);
  return {
    user: { ...user, admin: isAdmin(env, id) },
    logins, payments: payments.map((p) => ({ ...p, links: stripeLinks(p as unknown as PaymentRow) })),
    generations: await Promise.all(gens.map((g) => adminGen(env, g))),
    jobs, audit: events, ips, merged: merged.map((m) => m.id), redemption,
    address: { hash, blocks, twins },
    totals: {
      paid,
      spend_usd: gens.filter((g) => g.status !== "failed").reduce((a, g) => a + Number(g.est_usd || 0), 0),
      credits_spent: gens.filter((g) => g.status !== "failed" && !g.refunded).reduce((a, g) => a + Number(g.credits || 0), 0),
      failed: gens.filter((g) => g.status === "failed").length,
      films_usd: jobs.reduce((a, j) => a + Number((j as { cost_usd?: number }).cost_usd || 0), 0),
    },
    lookup: !!env.CF_ANALYTICS_TOKEN, retentionDays: IP_RETENTION_DAYS,
    attribution: await env.DB.prepare(`SELECT a.*, l.label AS link_label FROM user_attribution a LEFT JOIN short_links l ON l.code = a.link_code WHERE a.user_id = ?`)
      .bind(id).first().catch(() => null),
    // The gifts from the Kleo team, and whether the app showed them; the address a gift's e-mail would go to, the one
    // lookup the sheet shows and the e-mail uses (src/studio/gifts.ts).
    gifts: await giftsOf(env, id).catch(() => []),
    giftTo: await giftAddress(env, id).catch(() => null),
  };
}

async function targetUser(env: StudioEnv, id: string): Promise<{ id: string; ip_hash: string | null; credits: number; blocked_at: string | null }> {
  const u = await env.DB.prepare("SELECT id, ip_hash, credits, blocked_at FROM users WHERE id = ?").bind(id).first<{ id: string; ip_hash: string | null; credits: number; blocked_at: string | null }>();
  if (!u) throw new StudioError("No account with that id.", 404, "not_found");
  return u;
}
const notAdmin = (env: StudioEnv, id: string, what: string) => {
  if (isAdmin(env, id)) throw new StudioError(`An admin account can't be ${what} from the console.`, 400, "admin_target");
};

/** The admin session of this call, and whether a code was typed in it (the answer's cookie then says so). */
interface Gate { session: AdminSession; fresh: boolean }

/** The credits a change may move without a code typed in the last 5 minutes: alone, and added up (creditWithoutCode). */
const CREDITS_WITHOUT_CODE = 100;
/**
 * The CREDITS_WITHOUT_CODE condition in SQL: this admin's admin.credits changes (added or taken away alike) since the
 * code last typed stopped counting, plus this one, stay within the limit. Its three parameters: since, the admin's id,
 * this change's size.
 */
const WITHIN_SQL = `(SELECT COALESCE(SUM(ABS(json_extract(a.detail, '$.delta'))), 0) FROM audit a
    WHERE a.event = 'admin.credits' AND a.at > ? AND json_extract(a.detail, '$.admin') = ?) + ? <= ${CREDITS_WITHOUT_CODE}`;

/** The writes that want a code typed in the last 5 minutes (admin-auth.ts FRESH_MIN). */
export function dangerous(action: string, b: Record<string, unknown>, id: string, adminId: string): boolean {
  return action === "delete" || action === "key" || (action === "block" && b.on === true) || (action === "signout" && id !== adminId)
    || (action === "credits" && Math.abs(Math.trunc(Number(b.delta))) > CREDITS_WITHOUT_CODE)
    || (action === "gift" && Math.abs(Math.trunc(Number(b.credits))) > CREDITS_WITHOUT_CODE);
}

/**
 * A credit change made without a code typed in the last 5 minutes, only while such changes add up to no more than
 * CREDITS_WITHOUT_CODE: this admin's admin.credits rows on every account (added or taken away alike) since the code last
 * typed in this session stopped counting, plus this one. Otherwise many small changes would make one big one with no
 * code. The total is read and the change and its row written in one batch (one transaction), so changes sent at once
 * cannot all read the same total. The row is the one moveCredits writes. True when the change was made; false when it
 * wants a code. A gift's own row goes first in the batch, on the same condition (moveCredits).
 */
async function creditWithoutCode(env: StudioEnv, s: AdminSession, adminId: string, id: string, delta: number, detail: Record<string, unknown>, gift?: GiftDraft): Promise<boolean> {
  const since = new Date((s.fresh + FRESH_MIN * 60) * 1000).toISOString();
  const within = WITHIN_SQL;
  const w = [since, adminId, Math.abs(delta)];
  const withGift = gift ? " AND EXISTS (SELECT 1 FROM studio_gifts WHERE id = ?)" : "";
  const g = gift ? [gift.id] : [];
  const change = creditStatements(env, id, delta, detail, ` AND ${within}${withGift}`, [...w, ...g]);
  const out = await env.DB.batch([...(gift ? [giftInsert(env, gift, within, w)] : []), ...change.stmts]);
  return (out[(gift ? 1 : 0) + change.moves]?.meta.changes ?? 0) === 1;
}

/**
 * The statements of one credit change, after the gift's row when there is one: `cond` and `args` are the batch's own
 * condition (CREDITS_WITHOUT_CODE, the gift's row) and its parameters; `moves` is the index of the one that moves the
 * balance. An increase (Add credits, a gift): the balance, then its admin.credits row with the balance after. A decrease
 * (Take credits away; 31 October 2026): its admin.credits row first, with the balance before and after and the Kleo
 * Creators program credits before it, then the balance, then the program credits put back to what they were, never
 * above the new balance. The users_program_credits_spent trigger takes every decrease off the program credits first,
 * but credits taken away by hand were not spent, and program credits have their own expiry and take-back paths
 * (creators.ts). The decrease's later statements go by its row's own `change` id, so `cond` is read once, before that
 * row is written (the row itself counts toward CREDITS_WITHOUT_CODE afterwards).
 */
function creditStatements(env: StudioEnv, id: string, delta: number, detail: Record<string, unknown>, cond: string, args: unknown[]): { stmts: D1PreparedStatement[]; moves: number } {
  if (delta >= 0) {
    return { moves: 0, stmts: [
      env.DB.prepare(`UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ?${cond}`).bind(delta, id, ...args),
      env.DB.prepare(`INSERT INTO audit (user_id, job_id, event, detail) SELECT u.id, NULL, 'admin.credits', json_set(?, '$.after', u.credits) FROM users u WHERE u.id = ?${cond}`)
        .bind(JSON.stringify(detail), id, ...args),
    ] };
  }
  const change = rid("ch", 12);
  const row = "a.user_id = ? AND a.event = 'admin.credits' AND json_extract(a.detail, '$.change') = ?";
  return { moves: 1, stmts: [
    env.DB.prepare(`INSERT INTO audit (user_id, job_id, event, detail) SELECT u.id, NULL, 'admin.credits',
        json_set(?, '$.before', u.credits, '$.after', MAX(0, u.credits + ?), '$.program_before', u.program_credits, '$.change', ?) FROM users u WHERE u.id = ?${cond}`)
      .bind(JSON.stringify(detail), delta, change, id, ...args),
    env.DB.prepare(`UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ? AND EXISTS (SELECT 1 FROM audit a WHERE ${row})`).bind(delta, id, id, change),
    // After the trigger: the program credits as they were before the change, or the new balance if that is lower.
    env.DB.prepare(`UPDATE users SET program_credits = MIN(COALESCE((SELECT json_extract(a.detail, '$.program_before') FROM audit a WHERE ${row}), program_credits),
        MAX(0, credits)) WHERE id = ? AND EXISTS (SELECT 1 FROM audit a WHERE ${row})`).bind(id, change, id, id, change),
  ] };
}

/**
 * Moves an account's credits the way every action of the console does (Add credits, Take credits away, Gift credits):
 * one admin.credits audit row with the admin's id, the reason, the change, the balance before and after, and `extra`;
 * a decrease leaves a creator's program credits as they were, never above the new balance (creditStatements).
 * Without a code typed in the last 5 minutes, only while such changes add up to CREDITS_WITHOUT_CODE (creditWithoutCode);
 * past that, the code is asked for. A gift's row (gifts.ts giftInsert) is the batch's FIRST statement and the credits and
 * the audit row move only with it: a gift id already used fails that INSERT, and D1 rolls the whole batch back (one
 * transaction), so the same gift can never move credits twice. Answers the balance after.
 */
async function moveCredits(env: StudioEnv, request: Request, gate: Gate, adminId: string, u: { id: string; credits: number }, delta: number, reason: string,
  b: Record<string, unknown>, extra: Record<string, unknown> = {}, gift?: GiftDraft): Promise<number> {
  const detail = { admin: adminId, reason, delta, before: u.credits, ...extra };
  const balance = async () => (await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>())?.credits ?? 0;
  // Without a code typed in the last 5 minutes the small changes add up: past CREDITS_WITHOUT_CODE, this one wants a code.
  if (!gate.fresh && !isFresh(gate.session)) {
    if (await creditWithoutCode(env, gate.session, adminId, u.id, delta, detail, gift)) return balance();
    if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
    await checkFreshCode(env, request, adminId, b.code);
    gate.fresh = true;
  }
  const withGift = gift ? " AND EXISTS (SELECT 1 FROM studio_gifts WHERE id = ?)" : "";
  const g = gift ? [gift.id] : [];
  await env.DB.batch([...(gift ? [giftInsert(env, gift)] : []), ...creditStatements(env, u.id, delta, detail, withGift, g).stmts]);
  return balance();
}

/** A gift already given, answered as it is: no credits move, no audit row, no e-mail. */
async function giftAgain(env: StudioEnv, g: GiftRow): Promise<Response> {
  const credits = (await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(g.user_id).first<{ credits: number }>())?.credits ?? 0;
  const mail = g.mail ? { status: g.mail_status, to: g.mail_to, error: g.mail_error } : null;
  return json({ ok: true, again: true, credits, gift: { id: g.id, credits: g.credits, message: g.message, mail } });
}

/**
 * A gift from the Kleo team (src/studio/gifts.ts): the credits in at once through moveCredits, with the gift's row first
 * in the same batch (the app shows it once, on its next load), then the e-mail when asked for. The console makes the
 * gift's id once per sheet and sends it with every try: an id already given is answered as it is (giftAgain), so a second
 * click, or a request sent again after its answer was lost, gives nothing more. The e-mail never undoes the gift: what
 * came of it is in the answer, on the gift's row and in its admin.gift audit row. Everything from the credit batch to
 * the audit row runs as one piece of work under ctx.waitUntil, so a console tab closed at any point of it cannot cut
 * off the e-mail or the audit row. A closed, merged or deleted account, and one only an AI assistant uses (no Kleo
 * sign-in: its gift would be lost when it signs in), get nothing.
 */
async function giftAction(env: StudioEnv, request: Request, gate: Gate, adminId: string, u: { id: string; credits: number }, b: Record<string, unknown>, reason: string, ctx?: ExecutionContext): Promise<Response> {
  const id = b.id === undefined || b.id === null || b.id === "" ? rid("gf", 12) : String(b.id);
  if (!GIFT_ID.test(id)) throw new StudioError("Reload the page and try again.", 400, "gift_id");
  const before = await giftById(env, id);
  if (before) {
    if (before.user_id !== u.id) throw new StudioError("Reload the page and try again.", 409, "gift_id");
    return giftAgain(env, before);
  }
  const credits = Math.trunc(Number(b.credits));
  if (!Number.isFinite(credits) || credits < 1 || credits > 100_000) throw new StudioError("Type a whole number of credits, 1 or more.", 400, "credits");
  const message = giftMessage(b.message);
  const state = await env.DB.prepare(`SELECT blocked_at, merged_into, CASE WHEN email LIKE '%@deleted.kleo.invalid' THEN 1 ELSE 0 END AS deleted,
      CASE WHEN email LIKE '%@anon.kleo.invalid' AND NOT EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = users.id) THEN 1 ELSE 0 END AS anonymous
      FROM users WHERE id = ?`).bind(u.id).first<{ blocked_at: string | null; merged_into: string | null; deleted: number; anonymous: number }>();
  if (state?.deleted) throw new StudioError("This account was deleted: there's nobody to give it to.", 400, "gift_closed");
  if (state?.merged_into) throw new StudioError(`This account is now part of ${state.merged_into}. Give the gift there.`, 400, "gift_merged");
  if (state?.blocked_at) throw new StudioError("This account is closed. Reopen it first.", 400, "gift_closed");
  if (state?.anonymous) {
    throw new StudioError("Only an AI assistant uses this account, with no Kleo sign-in, so nobody would see the gift and it would be lost when they sign in. Use Add credits instead.", 400, "gift_anonymous");
  }
  const email = b.email === true;
  // From the credit batch to the e-mail and the audit row, one piece of work registered with waitUntil before its first
  // D1 call can answer: a tab closed at any point of it, the credit batch included, cannot cut off the e-mail or the
  // audit row of a gift whose credits went in.
  const work = (async (): Promise<Response> => {
    let after: number;
    try {
      after = await moveCredits(env, request, gate, adminId, u, credits, reason, b, { gift: id }, { id, userId: u.id, credits, reason, message, adminId, mail: email });
    } catch (e) {
      if (e instanceof StudioError) throw e;
      const now = await giftById(env, id).catch(() => null);
      if (!now || now.user_id !== u.id) throw e;
      // The same gift sent twice at once: the second batch failed on the gift's id and was rolled back.
      if (GIFT_ID_TAKEN.test(e instanceof Error ? e.message : String(e))) return giftAgain(env, now);
      // Any other trouble after this request's own batch went in (its answer lost, the balance read failing): the gift
      // is given, so the e-mail and the audit row still follow; mailGift's claim keeps the e-mail at most once.
      after = (await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(u.id).first<{ credits: number }>().catch(() => null))?.credits ?? u.credits + credits;
    }
    let mail: GiftMail | null = null;
    if (email) {
      // mailGift never throws once it sent; anything before that sent nothing, so the e-mail waits for "Send the e-mail again".
      try { mail = await mailGift(env, u.id, id); } catch (e) { mail = { status: "waiting", to: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
      if (!mail) {
        const g = await giftById(env, id).catch(() => null);
        mail = { status: (g?.mail_status ?? "waiting") as GiftMail["status"], to: g?.mail_to ?? null, error: g?.mail_error ?? null };
      }
    }
    await audit(asEnv(env), u.id, null, "admin.gift", { admin: adminId, reason, gift: id, credits, message: !!message, mail: mail?.status ?? "not asked" }).catch(() => {});
    return json({ ok: true, credits: after, gift: { id, credits, message, mail } });
  })();
  // A refusal (a code wanted, a wrong code) still reaches the console through the await below.
  ctx?.waitUntil(work.catch(() => {}));
  return await work;
}

/** The error D1 (SQLite) gives for a gift id that is already there: only that one means "the same gift, sent twice". */
const GIFT_ID_TAKEN = /UNIQUE constraint failed: studio_gifts\.id/i;

/**
 * CANCEL A GIFT (30 October 2026, after a gift went to a creator too early: Take credits away left the gift pending, and
 * its pop-up would still have announced the credits). Only a gift the person has not seen yet, in one of two ways, as
 * the console asks: with its credits back, min(the gift's credits, the balance) (never below 0), or with
 * `takeBack: false` only its pop-up stopped, for credits already taken away by hand: then no credits move, no
 * admin.credits row is written and no code is wanted. Every statement of the batch (cancelBatch) moves only while the
 * gift is still pending, and the last one ends that, so a second cancel (sent twice, or at once) changes nothing. The
 * take-back counts toward CREDITS_WITHOUT_CODE exactly as Take credits away does (over 100 at once, or past 100 in all, a
 * new code from the phone), and the batch never takes more than the amount checked here, whatever the balance became
 * meanwhile. A gift cancelled already is answered as it is.
 */
async function cancelGift(env: StudioEnv, request: Request, gate: Gate, adminId: string, userId: string, giftId: string, b: Record<string, unknown>): Promise<Response> {
  const reason = reasonOf(b);
  const u = await targetUser(env, userId);
  const g = await giftById(env, giftId);
  if (!g || g.user_id !== userId) throw new StudioError("No such gift on this account.", 404, "not_found");
  if (g.cancelled_at) return giftCancelled(env, g, true);
  if (g.seen_at) throw new StudioError("They have seen this gift already. Use Take credits away instead.", 409, "gift_seen");
  // The console's "Only stop the pop-up" sends takeBack: false; anything else takes the credits back.
  const takeBack = b.takeBack !== false;
  // The most this cancel takes back, checked against the code rule below: 0 for the pop-up alone.
  const cap = takeBack ? Math.min(Number(g.credits) || 0, Math.max(0, Number(u.credits) || 0)) : 0;
  const fresh = () => gate.fresh || isFresh(gate.session);
  const askCode = async () => {
    if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
    await checkFreshCode(env, request, adminId, b.code);
    gate.fresh = true;
  };
  // Over CREDITS_WITHOUT_CODE at once wants a code first, like Take credits away (dangerous()).
  if (cap > CREDITS_WITHOUT_CODE && !fresh()) await askCode();
  const detail = { admin: adminId, reason, gift: giftId, cancel: true };
  let done = false;
  // After a batch: cancelled (by this call, or by another one meanwhile: then it is answered as given back already),
  // seen meanwhile (the pop-up won, nothing moved), or still pending (a code is wanted).
  const outcome = async (): Promise<Response | null> => {
    const now = await giftById(env, giftId);
    if (now?.cancelled_at) return giftCancelled(env, now, !done);
    if (now?.seen_at) throw new StudioError("They have just seen this gift. Use Take credits away instead.", 409, "gift_seen");
    return null;
  };
  if (cap > 0 && !fresh()) {
    // Without a code typed in the last 5 minutes: only while the small changes add up to CREDITS_WITHOUT_CODE.
    const since = new Date((gate.session.fresh + FRESH_MIN * 60) * 1000).toISOString();
    done = await cancelBatch(env, userId, giftId, detail, takeBack, cap, [since, adminId, cap]);
    if (!done) {
      const r = await outcome();
      if (r) return r;
      await askCode();
    }
  }
  if (!done) done = await cancelBatch(env, userId, giftId, detail, takeBack, cap, null);
  const r = await outcome();
  if (r) return r;
  throw new StudioError("The gift couldn't be cancelled. Reload the page and try again.", 409, "gift_cancel");
}

/**
 * The batch of cancelGift, one transaction: the gift's admin.gift cancel row, with the credits that come back; when
 * `cap` is above 0, the take-back's admin.credits row (with the gift's id and the program credits before it), the
 * balance, and the Kleo Creators program credits put back to what they were, never above the new balance (the
 * users_program_credits_spent trigger takes every decrease off them, but a gift's credits went in as ordinary credits,
 * so only those may go); last, the gift marked cancelled and seen. The take is MIN(the gift's credits, the balance never
 * below 0, `cap`): never more than the amount cancelGift checked. `w`: the CREDITS_WITHOUT_CODE condition's parameters,
 * null with a fresh code or when nothing moves.
 */
async function cancelBatch(env: StudioEnv, userId: string, giftId: string, detail: Record<string, unknown>, takeBack: boolean, cap: number, w: unknown[] | null): Promise<boolean> {
  const moves = cap > 0;
  const W = moves && w ? ` AND ${WITHIN_SQL}` : "";
  const wa = W ? (w ?? []) : [];
  const pending = "g.cancelled_at IS NULL AND g.seen_at IS NULL";
  const of = `FROM users u JOIN studio_gifts g ON g.id = ? AND g.user_id = u.id WHERE u.id = ? AND ${pending}`;
  const take = "MIN(g.credits, MAX(0, u.credits), ?)";
  // The gift still pending: true until the last statement, in this batch only.
  const still = `EXISTS (SELECT 1 FROM studio_gifts g WHERE g.id = ? AND g.user_id = ? AND ${pending})`;
  // This cancel's own rows, written first in this batch while the gift is still pending: what the later statements go by.
  const giftRow = "a.user_id = ? AND a.event = 'admin.gift' AND json_extract(a.detail, '$.gift') = ? AND json_extract(a.detail, '$.action') = 'cancel'";
  const creditRow = "a.user_id = ? AND a.event = 'admin.credits' AND json_extract(a.detail, '$.gift') = ? AND json_extract(a.detail, '$.cancel') = 1";
  const stmts = [
    env.DB.prepare(`INSERT INTO audit (user_id, job_id, event, detail) SELECT u.id, NULL, 'admin.gift', json_set(?, '$.credits', ${moves ? take : "0"}) ${of}${W}`)
      .bind(JSON.stringify({ ...detail, action: "cancel", takeBack }), ...(moves ? [cap] : []), giftId, userId, ...wa),
  ];
  if (moves) {
    stmts.push(
      env.DB.prepare(`INSERT INTO audit (user_id, job_id, event, detail) SELECT u.id, NULL, 'admin.credits',
          json_set(?, '$.delta', -${take}, '$.before', u.credits, '$.after', u.credits - ${take}, '$.program_before', u.program_credits) ${of}${W}`)
        .bind(JSON.stringify(detail), cap, cap, giftId, userId, ...wa),
      env.DB.prepare(`UPDATE users SET credits = credits - MIN((SELECT g.credits FROM studio_gifts g WHERE g.id = ?), MAX(0, credits), ?)
          WHERE id = ? AND ${still} AND EXISTS (SELECT 1 FROM audit a WHERE ${creditRow})`)
        .bind(giftId, cap, userId, giftId, userId, userId, giftId),
      // After the trigger: the program credits as they were before the cancel, or the new balance if that is lower.
      env.DB.prepare(`UPDATE users SET program_credits = MIN(COALESCE((SELECT json_extract(a.detail, '$.program_before') FROM audit a WHERE ${creditRow}
            ORDER BY a.id DESC LIMIT 1), program_credits), MAX(0, credits))
          WHERE id = ? AND ${still} AND EXISTS (SELECT 1 FROM audit a WHERE ${creditRow})`)
        .bind(userId, giftId, userId, giftId, userId, userId, giftId),
    );
  }
  stmts.push(
    env.DB.prepare(`UPDATE studio_gifts SET cancelled_at = ${NOW}, seen_at = COALESCE(seen_at, ${NOW}),
        cancelled_credits = COALESCE((SELECT json_extract(a.detail, '$.credits') FROM audit a WHERE ${giftRow} ORDER BY a.id DESC LIMIT 1), 0)
        WHERE id = ? AND user_id = ? AND cancelled_at IS NULL AND seen_at IS NULL AND EXISTS (SELECT 1 FROM audit a WHERE ${giftRow})`)
      .bind(userId, giftId, giftId, userId, userId, giftId),
  );
  const out = await env.DB.batch(stmts);
  return (out[out.length - 1]?.meta.changes ?? 0) === 1;
}

/** A cancelled gift as the console reads it, with the balance after; `again` when it was cancelled before this call. */
async function giftCancelled(env: StudioEnv, g: GiftRow, again: boolean): Promise<Response> {
  const credits = (await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(g.user_id).first<{ credits: number }>())?.credits ?? 0;
  return json({ ok: true, ...(again ? { again: true } : {}), credits, gift: { id: g.id, credits: g.credits, cancelled_at: g.cancelled_at, cancelled_credits: g.cancelled_credits ?? 0 } });
}

async function userAction(env: StudioEnv, request: Request, gate: Gate, adminId: string, id: string, action: string, ctx?: ExecutionContext): Promise<Response> {
  const u = await targetUser(env, id);
  const b = await body(request);
  // A lookup only reads; its audit row says what it was when no reason is typed.
  const reason = reasonOf(action === "ip-lookup" && !b.reason ? { reason: "Looked up the address of a past event" } : b);
  if (dangerous(action, b, id, adminId) && !isFresh(gate.session)) {
    if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
    await checkFreshCode(env, request, adminId, b.code);
    gate.fresh = true;
  }
  const log = (event: string, detail: Record<string, unknown> = {}) => audit(asEnv(env), id, null, event, { admin: adminId, reason, ...detail });

  if (action === "credits") {
    const delta = Math.trunc(Number(b.delta));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100_000) throw new StudioError("Type a whole number of credits, not zero.", 400, "delta");
    return json({ ok: true, credits: await moveCredits(env, request, gate, adminId, u, delta, reason, b) });
  }
  if (action === "gift") return giftAction(env, request, gate, adminId, u, b, reason, ctx);
  if (action === "block") {
    const on = b.on === true;
    if (on) {
      notAdmin(env, id, "closed");
      await env.DB.prepare(`UPDATE users SET blocked_at = ${NOW}, blocked_reason = ? WHERE id = ?`).bind(reason, id).run();
      // Out everywhere: every session, and every assistant connected with the old key (its grant carries the version).
      await endAllSessions(env, id);
      await rotateKey(asEnv(env), id);
      await endMergedSessions(env, id);
      await log("admin.block");
    } else {
      await env.DB.prepare("UPDATE users SET blocked_at = NULL, blocked_reason = NULL WHERE id = ?").bind(id).run();
      await log("admin.unblock");
    }
    return json({ ok: true, blocked: on });
  }
  if (action === "address") {
    // Only an address this account is known by: its sign-up fingerprint, or one of its recorded sign-ins.
    const hash = typeof b.hash === "string" && b.hash ? b.hash : u.ip_hash;
    if (!hash) throw new StudioError("This account has no address on record.", 400, "no_address");
    const known = hash === u.ip_hash || !!(await env.DB.prepare("SELECT 1 AS one FROM studio_ips WHERE user_id = ? AND ip_hash = ? LIMIT 1").bind(id, hash).first());
    if (!known) throw new StudioError("That address isn't one of this account's.", 400, "foreign_address");
    if (b.on === true) {
      notAdmin(env, id, "blocked by address");
      const days = int(b.days, 30, 1, 3650);
      await blockAddress(env, hash, `admin: ${reason}`.slice(0, 300), days);
      await log("admin.address_block", { hash, days });
    } else {
      await env.DB.prepare("DELETE FROM blocked_addresses WHERE ip_hash = ?").bind(hash).run();
      await log("admin.address_unblock", { hash });
    }
    return json({ ok: true });
  }
  if (action === "key") {
    await rotateKey(asEnv(env), id);
    await endAllSessions(env, id);
    await endMergedSessions(env, id);
    await log("admin.key_reset");
    return json({ ok: true });
  }
  if (action === "signout") {
    await endAllSessions(env, id);
    await log("admin.signout");
    return json({ ok: true });
  }
  if (action === "delete") {
    notAdmin(env, id, "deleted");
    if (String(b.confirm ?? "").trim().toUpperCase() !== "DELETE") throw new StudioError("Type DELETE to confirm.", 400, "confirm");
    await log("admin.delete");
    await deleteAccount(env, id, "DELETE");
    return json({ ok: true });
  }
  if (action === "ip-lookup") return ipLookup(env, adminId, id, b, reason);
  return json({ error: "Not found." }, 404);
}

/** The address of one past event of this account, read from Cloudflare's request logs (src/studio/ip-lookup.ts). */
async function ipLookup(env: StudioEnv, adminId: string, id: string, b: Record<string, unknown>, reason: string): Promise<Response> {
  if (!env.CF_ANALYTICS_TOKEN) throw new StudioError("Add the CF_ANALYTICS_TOKEN secret first (a Cloudflare token that can read analytics).", 400, "no_token");
  const row = await env.DB.prepare("SELECT id, at, event, detail FROM audit WHERE id = ? AND user_id = ?").bind(int(b.audit, 0, 0, Number.MAX_SAFE_INTEGER), id)
    .first<{ id: number; at: string; event: string; detail: string | null }>();
  if (!row) throw new StudioError("That event isn't on this account.", 404, "no_event");
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit WHERE user_id IS NOT NULL AND event = 'admin.ip_lookup' AND at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')`).first<{ n: number }>();
  if ((recent?.n ?? 0) >= LOOKUPS_PER_HOUR) throw new StudioError("Cloudflare allows only a few lookups: wait an hour.", 429, "lookup_rate");
  let found;
  try {
    found = await lookupRequests(env.CF_ANALYTICS_TOKEN, env.CF_ZONE_ID || KLEO_ZONE, row.at, pathsFor(row.event, row.detail));
  } catch (e) {
    throw new StudioError(e instanceof Error ? e.message : "Cloudflare could not be asked.", 502, "lookup_failed");
  }
  const best = found.best;
  // Remembered like a recorded sign-in, at the event's own time, so the next visit needs no lookup.
  if (best) {
    await env.DB.prepare("INSERT INTO studio_ips (user_id, at, event, ip, ip_hash, country, ua) VALUES (?, ?, 'lookup', ?, ?, ?, ?)")
      .bind(id, row.at, best.ip, await ipFingerprint(asEnv(env), best.ip), best.country, best.ua).run();
  }
  await audit(asEnv(env), id, null, "admin.ip_lookup", { admin: adminId, reason, audit: row.id, found: !!best });
  return json({ event: row, best, rows: found.rows });
}

// ── money ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface PaymentRow { session_id: string; payment_intent: string | null }
/** The Stripe dashboard pages of a payment: its PaymentIntent, and its Checkout Session or invoice. */
export function stripeLinks(p: PaymentRow): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const base = (id: string) => `https://dashboard.stripe.com${/_test_/.test(id) ? "/test" : ""}`;
  if (p.payment_intent?.startsWith("pi_")) out.push({ label: "Payment", url: `${base(p.payment_intent)}/payments/${encodeURIComponent(p.payment_intent)}` });
  const s = p.session_id ?? "";
  if (s.startsWith("cs_")) out.push({ label: "Checkout", url: `${base(s)}/search?query=${encodeURIComponent(s)}` });
  else if (s.startsWith("in_")) out.push({ label: "Invoice", url: `${base(s)}/invoices/${encodeURIComponent(s)}` });
  else if (s.startsWith("pi_") && !p.payment_intent) out.push({ label: "Payment", url: `${base(s)}/payments/${encodeURIComponent(s)}` });
  return out;
}

async function listPayments(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const status = ["paid", "refunded", "disputed"].includes(url.searchParams.get("status") ?? "") ? url.searchParams.get("status") : null;
  const limit = int(url.searchParams.get("limit"), 100, 1, 500), offset = int(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const rows = (await env.DB.prepare(`SELECT p.session_id, p.user_id, p.credits, p.amount_cent, p.currency, p.email, p.payment_intent, p.status, p.country,
        p.event_type, p.raw_ref, p.at, u.display_name AS name, ${EMAIL_SQL} AS account_email
      FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE (?1 IS NULL OR p.status = ?1) ORDER BY p.at DESC LIMIT ?2 OFFSET ?3`)
    .bind(status, limit, offset).all<PaymentRow & Record<string, unknown>>()).results;
  const real = "status = 'paid' AND amount_cent > 0";
  const [days, months, totals, states] = await Promise.all([
    env.DB.prepare(`SELECT substr(at, 1, 10) AS day, currency, SUM(amount_cent) AS cents, COUNT(*) AS n FROM payments WHERE ${real} AND at >= ${ago(29).replace("%H:%M:%fZ", "00:00:00.000Z")} GROUP BY day, currency ORDER BY day`).all(),
    env.DB.prepare(`SELECT substr(at, 1, 7) AS month, currency, SUM(amount_cent) AS cents, COUNT(*) AS n FROM payments WHERE ${real} GROUP BY month, currency ORDER BY month DESC LIMIT 36`).all(),
    env.DB.prepare(`SELECT currency, SUM(amount_cent) AS total, SUM(CASE WHEN at >= ${ago(30)} THEN amount_cent ELSE 0 END) AS d30,
        SUM(CASE WHEN at >= strftime('%Y-%m-01T00:00:00.000Z','now') THEN amount_cent ELSE 0 END) AS month, SUM(CASE WHEN at >= ${TODAY} THEN amount_cent ELSE 0 END) AS today,
        COUNT(*) AS n, COUNT(DISTINCT user_id) AS payers FROM payments WHERE ${real} GROUP BY currency`).all(),
    env.DB.prepare("SELECT status, COUNT(*) AS n, SUM(amount_cent) AS cents FROM payments WHERE amount_cent > 0 GROUP BY status").all(),
  ]);
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE (?1 IS NULL OR status = ?1)").bind(status).first<{ n: number }>())?.n ?? 0;
  return {
    payments: rows.map((p) => ({ ...p, links: stripeLinks(p) })), total: count, offset, limit,
    days: days.results, months: months.results, totals: totals.results, states: states.results,
  };
}

// ── creations ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function listGenerations(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const st = url.searchParams.get("status");
  const status = st === "running" ? ["submitting", "running", "saving"] : st === "done" || st === "failed" ? [st] : null;
  const kind = ["video", "image", "tool", "film"].includes(url.searchParams.get("kind") ?? "") ? url.searchParams.get("kind") : null;
  const user = /^u_[a-z0-9]+$/.test(url.searchParams.get("user") ?? "") ? url.searchParams.get("user") : null;
  const before = url.searchParams.get("before") || null;
  const limit = int(url.searchParams.get("limit"), 48, 1, 120);
  const rows = (await env.DB.prepare(`SELECT g.*, ${EMAIL_SQL} AS email FROM studio_generations g LEFT JOIN users u ON u.id = g.user_id
      WHERE (?1 IS NULL OR g.status IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR g.kind = ?2) AND (?3 IS NULL OR g.user_id = ?3)
        AND (?4 IS NULL OR g.created_at < ?4) ORDER BY g.created_at DESC LIMIT ?5`)
    .bind(status ? JSON.stringify(status) : null, kind, user, before, limit).all<GenerationRow & { email: string | null }>()).results;
  return { generations: await Promise.all(rows.map((g) => adminGen(env, g))), more: rows.length === limit };
}

/** What kind of failure a provider's answer is, in plain words (the console groups by it). */
export function failureKind(text: string): string {
  const t = text || "";
  if (EPHONE_NO_MONEY_RE.test(t) || APIMART_NO_MONEY_RE.test(t) || /being recharged|out of credit/i.test(t)) return "Provider out of credit";
  if (/copyright|版权|protected content|intellectual property/i.test(t)) return "Copyright refusal";
  if (/too ?small|HeightTooSmall|WidthTooSmall|resolution .*(?:low|small)|at least \d+ ?px/i.test(t)) return "Picture too small";
  if (/sensitive|safety|moderat|nsfw|inappropriate|policy|violat|违规|敏感|审核/i.test(t)) return "Content refused";
  if (/time(?:d)? ?out|took too long|deadline/i.test(t)) return "Took too long";
  if (/\b5\d\d\b|unavailable|overloaded|fetch failed|network|ECONN|bad gateway/i.test(t)) return "Provider error";
  return "Other";
}
/** The same text without what changes from one failure to the next (ids, amounts, times). */
export const failureText = (t: string): string =>
  (t || "").replace(/\(request id:[^)]*\)?/gi, "").replace(/\b[0-9a-f]{12,}\b/gi, "…").replace(/[＄$]\s*\d+(?:\.\d+)?/g, "$…").replace(/\s+/g, " ").trim().slice(0, 220);

async function failures(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const days = int(url.searchParams.get("days"), 7, 1, 365);
  const rows = (await env.DB.prepare(`SELECT g.id, g.user_id, g.kind, g.model, g.task_id, g.slots, g.error, g.created_at, g.credits, g.refunded,
        (SELECT a.detail FROM audit a WHERE a.job_id = g.id AND a.event = 'studio.failed' ORDER BY a.id DESC LIMIT 1) AS detail
      FROM studio_generations g WHERE g.status = 'failed' AND g.created_at >= ${ago(days)} ORDER BY g.created_at DESC LIMIT 1000`)
    .all<GenerationRow & { detail: string | null }>()).results;
  const groups = new Map<string, { kind: string; provider: string; count: number; users: Set<string>; models: Set<string>; last: string; sample: string; ids: string[]; credits: number }>();
  for (const g of rows) {
    let said = "";
    try { const d = JSON.parse(g.detail ?? "{}"); said = String(d.provider ?? d.why ?? ""); } catch { /* none */ }
    const text = said || g.error || "";
    const kind = failureKind(`${text} ${g.error ?? ""}`);
    const provider = providerOf(g);
    const key = `${kind}|${provider}`;
    const e = groups.get(key) ?? { kind, provider, count: 0, users: new Set(), models: new Set(), last: g.created_at, sample: failureText(text), ids: [], credits: 0 };
    e.count++; e.users.add(g.user_id); e.models.add(g.model); e.credits += g.refunded ? 0 : Number(g.credits || 0);
    if (e.ids.length < 5) e.ids.push(g.id);
    groups.set(key, e);
  }
  return {
    days, total: rows.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count).map((e) => ({ ...e, users: e.users.size, models: [...e.models] })),
  };
}

async function spend(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const days = int(url.searchParams.get("days"), 30, 0, 3650);
  const since = days ? ago(days) : "''";
  const rows = (await env.DB.prepare(`SELECT g.user_id AS id, COUNT(*) AS gens, SUM(g.status = 'failed') AS failed,
        SUM(CASE WHEN g.status != 'failed' THEN g.est_usd ELSE 0 END) AS usd,
        SUM(CASE WHEN g.status != 'failed' AND g.refunded = 0 THEN g.credits ELSE 0 END) AS credits, MAX(g.created_at) AS last,
        (SELECT ${EMAIL_SQL} FROM users u WHERE u.id = g.user_id) AS email,
        (SELECT COALESCE(SUM(p.amount_cent), 0) FROM payments p WHERE p.user_id = g.user_id AND p.status = 'paid' AND p.amount_cent > 0) AS paid_cent,
        (SELECT MAX(p.currency) FROM payments p WHERE p.user_id = g.user_id AND p.amount_cent > 0) AS currency
      FROM studio_generations g WHERE g.created_at >= ${since} GROUP BY g.user_id ORDER BY usd DESC LIMIT 200`).all<Record<string, unknown>>()).results;
  return { days, users: rows.map((r) => ({ ...r, admin: isAdmin(env, String(r.id)) })), usd: rows.reduce((a, r) => a + Number(r.usd || 0), 0) };
}

// ── sources: where accounts come from (25 October 2026, src/studio/attribution.ts) ────────────────────────────────

/** The address short links are written with: the app's own public host. */
export const linkBase = (env: StudioEnv): string => `https://${(env.CANONICAL_HOST ?? "").trim() || "app.kleooai.com"}`;

interface Funnel { visits: number; clicks: number; signups: number; guessed: number; made: number; paying: number; paid: Record<string, number> }
const funnel = (): Funnel => ({ visits: 0, clicks: 0, signups: 0, guessed: 0, made: 0, paying: 0, paid: {} });

/**
 * The Sources page. The accounts are the ones opened in the period (a cohort): how many made something since, how many
 * paid, and what they paid so far. First visits and clicks are the ones counted in the period. An account with no
 * attribution row is "before" (opened before tracking began), "assistant" (opened outside the app, by the MCP server) or
 * "deleted" (its row went with the account's data).
 * Admin accounts are left out.
 */
async function sources(env: StudioEnv, url: URL): Promise<Record<string, unknown>> {
  const days = int(url.searchParams.get("days"), 30, 0, 3650);
  const since = days ? new Date(Date.now() - days * 86400e3).toISOString() : "";
  const sinceDay = since.slice(0, 10);
  const all = async <T = Record<string, any>>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
  const tracking = (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = 'attribution_since'").first<{ value: string }>().catch(() => null))?.value ?? null;
  const [accounts, pays, links, clicks, visits, newest] = await Promise.all([
    all(`SELECT u.id, u.created_at, a.channel, a.guessed, a.link_code, a.utm_source, a.src, a.ref_host,
        CASE WHEN u.email LIKE '%@deleted.kleo.invalid' THEN 1 ELSE 0 END AS deleted, EXISTS (SELECT 1 FROM studio_generations g WHERE g.user_id = u.id AND g.status = 'done') AS made
      FROM users u LEFT JOIN user_attribution a ON a.user_id = u.id WHERE u.created_at >= ?1 AND u.merged_into IS NULL ORDER BY u.created_at DESC LIMIT 20000`, since),
    all(`SELECT p.user_id, p.currency, SUM(p.amount_cent) AS cents FROM payments p JOIN users u ON u.id = p.user_id
      WHERE u.created_at >= ?1 AND u.merged_into IS NULL AND p.status = 'paid' AND p.amount_cent > 0 GROUP BY p.user_id, p.currency`, since),
    all<LinkRow & { created_at: string; created_by: string | null }>("SELECT code, channel, label, target, created_at, created_by, archived_at FROM short_links ORDER BY created_at DESC, code"),
    all("SELECT code, SUM(clicks) AS total, SUM(CASE WHEN day >= ?1 THEN clicks ELSE 0 END) AS period FROM short_link_clicks GROUP BY code", sinceDay),
    all("SELECT channel, link_code, SUM(n) AS n FROM first_visits WHERE day >= ?1 GROUP BY channel, link_code", sinceDay),
    all(`SELECT u.id, u.created_at, u.display_name AS name, ${EMAIL_SQL} AS email, a.channel, a.guessed, a.link_code, l.label AS link_label, a.utm_source, a.utm_campaign,
        a.src, a.ref_host, a.landing, a.in_app, CASE WHEN u.email LIKE '%@deleted.kleo.invalid' THEN 1 ELSE 0 END AS deleted FROM users u LEFT JOIN user_attribution a ON a.user_id = u.id LEFT JOIN short_links l ON l.code = a.link_code
      WHERE u.created_at >= ?1 AND u.merged_into IS NULL ORDER BY u.created_at DESC LIMIT 40`, since),
  ]);
  const paidBy = new Map<string, Record<string, number>>();
  for (const p of pays) paidBy.set(p.user_id, { ...(paidBy.get(p.user_id) ?? {}), [p.currency]: Number(p.cents) || 0 });
  const channels = new Map<string, Funnel>(), byLink = new Map<string, Funnel>(), others = new Map<string, number>();
  const row = (m: Map<string, Funnel>, k: string) => { let r = m.get(k); if (!r) m.set(k, (r = funnel())); return r; };
  // No row: deleted with its account, opened before tracking began, or opened outside the app (the MCP server's sign-in).
  const bucket = (a: Record<string, any>) => a.channel ?? (a.deleted ? "deleted" : tracking && String(a.created_at) >= tracking ? "assistant" : "before");
  for (const a of accounts) {
    if (isAdmin(env, a.id)) continue;
    const paid = paidBy.get(a.id);
    const targets = [row(channels, bucket(a)), ...(a.link_code ? [row(byLink, a.link_code)] : [])];
    for (const r of targets) {
      r.signups++;
      if (a.guessed) r.guessed++;
      if (a.made) r.made++;
      if (paid) { r.paying++; for (const [c, cents] of Object.entries(paid)) r.paid[c] = (r.paid[c] ?? 0) + cents; }
    }
    if (a.channel === "other") { const k = a.ref_host ?? a.utm_source ?? a.src ?? "?"; others.set(k, (others.get(k) ?? 0) + 1); }
  }
  for (const v of visits) {
    row(channels, v.channel).visits += Number(v.n) || 0;
    if (v.link_code) row(byLink, v.link_code).visits += Number(v.n) || 0;
  }
  const clickOf = new Map(clicks.map((c) => [c.code, c]));
  for (const l of links) {
    const n = Number(clickOf.get(l.code)?.period) || 0;
    row(byLink, l.code).clicks += n;
    if (n) row(channels, l.channel).clicks += n;
  }
  const total = funnel();
  for (const r of channels.values()) {
    for (const k of ["visits", "clicks", "signups", "guessed", "made", "paying"] as const) total[k] += r[k];
    for (const [c, cents] of Object.entries(r.paid)) total.paid[c] = (total.paid[c] ?? 0) + cents;
  }
  const base = linkBase(env);
  return {
    days, since: since || null, tracking, base, total,
    channels: [...channels.entries()].map(([channel, r]) => ({ channel, ...r })).sort((a, b) => b.signups - a.signups || b.visits - a.visits || b.clicks - a.clicks),
    links: links.map((l) => ({ ...l, url: `${base}/r/${l.code}`, archived: !!l.archived_at, clicks_all: Number(clickOf.get(l.code)?.total) || 0, ...(byLink.get(l.code) ?? funnel()) })),
    others: [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, signups]) => ({ label, signups })),
    newest: newest.filter((u) => !isAdmin(env, u.id)).map((u) => ({ ...u, channel: bucket(u), paid: paidBy.get(u.id) ?? null })),
  };
}

const LINK_PREFIX: Record<LinkChannel, string> = { instagram: "ig", tiktok: "tt", x: "x", youtube: "yt", facebook: "fb", dm: "dm", other: "go" };
/** A label in plain letters and dashes, for a code: "Lupin Paris Fire Dance" is "lupin-paris-fire-dance". */
export const slugOf = (label: string): string =>
  label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
/** Why a page can't be a short link's target, or null: a path of the app or the site, never another host or a loop. */
export function linkTargetProblem(target: string): string | null {
  const shape = "The page is a path of the app, like / or /templates.";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || target.length > 300) return shape;
  let u: URL;
  try { u = new URL(target, "https://kleo.invalid"); } catch { return shape; }
  if (u.origin !== "https://kleo.invalid") return shape;
  if (/^\/(?:r|api|auth|media)\//i.test(u.pathname) || /^\/admin(?:\/|$)/i.test(u.pathname)) return "A short link can't open that page.";
  return null;
}
const linkOut = (env: StudioEnv, l: LinkRow) => ({ ...l, url: `${linkBase(env)}/r/${l.code}`, archived: !!l.archived_at });
const labelOf = (v: unknown): string => {
  const label = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (label.length < 2) throw new StudioError("Say which bio, post or video the link is for.", 400, "label");
  return label;
};
const targetOf = (v: unknown): string => {
  const target = String(v ?? "").trim() || "/";
  const bad = linkTargetProblem(target);
  if (bad) throw new StudioError(bad, 400, "target");
  return target;
};

/** A new short link. With no code, one is made from the network and the label ("tt-lupin-paris-fire-dance"). */
async function createLink(env: StudioEnv, adminId: string, b: Record<string, unknown>): Promise<Response> {
  const channel = LINK_CHANNELS.find((c) => c === b.channel);
  if (!channel) throw new StudioError("Pick the network the link is for.", 400, "channel");
  const label = labelOf(b.label), target = targetOf(b.target);
  const taken = async (c: string) => !!(await getLink(env, c));
  let code = String(b.code ?? "").trim().toLowerCase();
  if (code) {
    if (code.length < 2 || !CODE_RE.test(code)) throw new StudioError("A code is 2 to 32 small letters, digits or dashes, like ig-bio.", 400, "code");
    if (await taken(code)) throw new StudioError("That code is taken. Pick another one.", 409, "code_taken");
  } else {
    const base = `${LINK_PREFIX[channel]}-${slugOf(label) || "link"}`.slice(0, 32).replace(/-+$/, "");
    code = base;
    for (let i = 2; await taken(code); i++) code = `${base.slice(0, 31 - String(i).length).replace(/-+$/, "")}-${i}`;
  }
  const r = await env.DB.prepare("INSERT OR IGNORE INTO short_links (code, channel, label, target, created_by) VALUES (?, ?, ?, ?, ?)").bind(code, channel, label, target, adminId).run();
  if (!r.meta?.changes) throw new StudioError("That code is taken. Pick another one.", 409, "code_taken");
  await audit(asEnv(env), adminId, null, "admin.link_created", { admin: adminId, code, channel, label, target });
  return json({ link: linkOut(env, (await getLink(env, code))!) });
}

/** Changes a link's label or page, or hides it from the list (a hidden link keeps working: posts keep their links). */
async function changeLink(env: StudioEnv, adminId: string, code: string, b: Record<string, unknown>): Promise<Response> {
  const link = await getLink(env, code);
  if (!link) throw new StudioError("No short link with that code.", 404, "not_found");
  const label = b.label === undefined ? link.label : labelOf(b.label);
  const target = b.target === undefined ? link.target : targetOf(b.target);
  const archived = b.archived === undefined ? !!link.archived_at : b.archived === true;
  await env.DB.prepare(`UPDATE short_links SET label = ?, target = ?, archived_at = CASE WHEN ? THEN COALESCE(archived_at, ${NOW}) ELSE NULL END WHERE code = ?`)
    .bind(label, target, archived ? 1 : 0, link.code).run();
  await audit(asEnv(env), adminId, null, "admin.link_changed", { admin: adminId, code: link.code, before: { label: link.label, target: link.target, archived: !!link.archived_at }, after: { label, target, archived } });
  return json({ link: linkOut(env, (await getLink(env, link.code))!) });
}

// ── the first page ────────────────────────────────────────────────────────────────────────────────────────────────

async function overview(env: StudioEnv): Promise<Record<string, unknown>> {
  const c = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@deleted.kleo.invalid' AND merged_into IS NULL) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${ago(1)}) AS users_1d,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${ago(7)}) AS users_7d,
      (SELECT COUNT(DISTINCT user_id) FROM payments WHERE status = 'paid' AND amount_cent > 0) AS payers,
      (SELECT COUNT(*) FROM users WHERE blocked_at IS NOT NULL) AS blocked,
      (SELECT COUNT(*) FROM blocked_addresses WHERE until > ${NOW}) AS blocked_addresses,
      (SELECT COUNT(*) FROM studio_generations WHERE created_at >= ${TODAY}) AS gens_today,
      (SELECT COUNT(*) FROM studio_generations WHERE status = 'failed' AND created_at >= ${ago(1)}) AS failed_1d,
      (SELECT COUNT(*) FROM studio_generations WHERE created_at >= ${ago(1)}) AS gens_1d,
      (SELECT COUNT(*) FROM studio_generations WHERE status IN ('submitting','running','saving')) AS running,
      (SELECT COALESCE(SUM(est_usd), 0) FROM studio_generations WHERE status != 'failed' AND created_at >= ${ago(7)}) AS spend_7d,
      (SELECT COALESCE(SUM(est_usd), 0) FROM studio_generations WHERE status != 'failed' AND created_at >= ${ago(30)}) AS spend_30d`).first<Record<string, number>>();
  const revenue = (await env.DB.prepare(`SELECT currency, SUM(amount_cent) AS total, SUM(CASE WHEN at >= ${ago(30)} THEN amount_cent ELSE 0 END) AS d30,
      SUM(CASE WHEN at >= ${TODAY} THEN amount_cent ELSE 0 END) AS today, COUNT(*) AS n FROM payments WHERE status = 'paid' AND amount_cent > 0 GROUP BY currency`).all()).results;
  const trouble = (await env.DB.prepare("SELECT status, COUNT(*) AS n, SUM(amount_cent) AS cents FROM payments WHERE status != 'paid' AND amount_cent > 0 GROUP BY status").all()).results;
  const newest = (await env.DB.prepare(`SELECT u.id, u.display_name AS name, u.created_at, u.credits, ${EMAIL_SQL} AS email, ${LAST_IP("country")} AS country, ${LAST_IP("city")} AS city
      FROM users u ORDER BY u.created_at DESC LIMIT 6`).all()).results;
  const payments = (await env.DB.prepare(`SELECT p.session_id, p.user_id, p.amount_cent, p.currency, p.credits, p.status, p.at, p.country, ${EMAIL_SQL} AS email
      FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.amount_cent > 0 ORDER BY p.at DESC LIMIT 6`).all()).results;
  const failed = (await env.DB.prepare(`SELECT g.*, ${EMAIL_SQL} AS email FROM studio_generations g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.status = 'failed' ORDER BY g.created_at DESC LIMIT 6`).all<GenerationRow & { email: string | null }>()).results;
  const num = (v: string | undefined, d: number) => (Number.isFinite(parseFloat(v ?? "")) ? parseFloat(v!) : d);
  return {
    counts: c, revenue, trouble, newest, payments, failed: await Promise.all(failed.map((g) => adminGen(env, g))),
    budget: {
      day: num(env.STUDIO_DAILY_BUDGET_USD, 30), spent: await studioSpentTodayUsd(env),
      freeDay: num(env.STUDIO_FREE_DAILY_BUDGET_USD, 8), freeSpent: await studioSpentTodayUsd(env, { unpaidOnly: true }),
    },
  };
}

const SETTINGS = ["STUDIO_DAILY_BUDGET_USD", "STUDIO_FREE_DAILY_BUDGET_USD", "STUDIO_MARGIN", "STUDIO_VIDEO_FACTOR", "FREE_CREDITS", "STUDIO_FREE_MODELS", "STUDIO_FREE_IMAGE_MODELS",
  "STUDIO_PAUSED_IMAGE_MODELS", "STUDIO_MAX_RUNNING", "STUDIO_BACKUPS", "MAX_NEW_USERS_PER_DAY", "MAX_GIFTS_PER_ADDRESS", "MAX_ACCOUNTS_PER_ADDRESS", "STUDIO_ADMINS", "CANONICAL_HOST"];

// ── the router ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function adminApi(env: StudioEnv, request: Request, url: URL, adminId: string, ctx?: ExecutionContext): Promise<Response> {
  // The console's own sign-in first; every other route wants its admin session.
  const auth = await adminAuthApi(env, request, url, adminId);
  if (auth) return auth;
  const session = await adminSessionOf(env, request, adminId);
  if (!session) {
    const enrolled = !!(await env.DB.prepare("SELECT secret FROM studio_admin WHERE user_id = ? AND secret IS NOT NULL").bind(adminId).first());
    return json({ error: enrolled ? "Type the code from your phone to open the console." : "Set up the console's second factor first.", code: enrolled ? "admin_signin" : "admin_enroll" }, 401);
  }
  const gate: Gate = { session, fresh: false };
  const res = await adminRoute(env, request, url, adminId, gate, ctx);
  // Every call the owner makes keeps the admin session alive for another 30 minutes, up to its 12 hours. The page's own
  // refreshes (admin.js live(), header X-Kleo-Auto on reads) do not: a console left open still closes after 30 idle minutes.
  const auto = request.method === "GET" && request.headers.get("x-kleo-auto") === "1";
  if (!auto) res.headers.append("set-cookie", await touchSession(env, session, Date.now(), gate.fresh));
  return res;
}

async function adminRoute(env: StudioEnv, request: Request, url: URL, adminId: string, gate: Gate, ctx?: ExecutionContext): Promise<Response> {
  const path = url.pathname, method = request.method;
  if (method === "GET") {
    if (path === "/api/admin/security") return json(await securityInfo(env, adminId, gate.session));
    if (path === "/api/admin/overview") return json(await overview(env));
    if (path === "/api/admin/users") return json(await listUsers(env, url));
    const um = path.match(/^\/api\/admin\/users\/(u_[a-z0-9]+)$/);
    if (um) return json(await userDetail(env, um[1]));
    if (path === "/api/admin/payments") return json(await listPayments(env, url));
    if (path === "/api/admin/generations") return json(await listGenerations(env, url));
    if (path === "/api/admin/failures") return json(await failures(env, url));
    if (path === "/api/admin/spend") return json(await spend(env, url));
    if (path === "/api/admin/providers") {
      const e = env as unknown as Record<string, string | undefined>;
      return json({ secrets: secretStatus(env), balances: await balances(env), lookup: !!env.CF_ANALYTICS_TOKEN, settings: SETTINGS.map((name) => ({ name, value: e[name] ?? null })) });
    }
    if (path === "/api/admin/keys") return json(await listKeys(env));
    if (path === "/api/admin/sources") return json(await sources(env, url));
    if (path === "/api/admin/emails") return json(await emails(env));
    if (path === "/api/admin/emails/preview") return json(emailPreview(env, url));
    if (path === "/api/admin/outreach") return json(await outreachOverview(env));
    if (path === "/api/admin/outreach/prospects") return json(await listProspects(env, url));
    if (path === "/api/admin/outreach/preview") return json(await previewFor(env, url));
    if (path === "/api/admin/creators") return json(await adminCreators(env));
    const cm = path.match(/^\/api\/admin\/creators\/(u_[a-z0-9]+)$/);
    if (cm) return json(await adminCreator(env, cm[1]));
  }
  if (method === "POST") {
    const am = path.match(/^\/api\/admin\/users\/(u_[a-z0-9]+)\/(credits|gift|block|address|key|signout|delete|ip-lookup)$/);
    if (am) return userAction(env, request, gate, adminId, am[1], am[2], ctx);
    // A gift's e-mail that is waiting (src/studio/gifts.ts): sent again, at most once.
    // A gift the person has not seen yet, cancelled (its credits back, its pop-up never shown).
    const cgm = path.match(/^\/api\/admin\/users\/(u_[a-z0-9]+)\/gifts\/(gf_[a-z0-9]{6,20})\/cancel$/);
    if (cgm) return cancelGift(env, request, gate, adminId, cgm[1], cgm[2], await body(request));
    const gm = path.match(/^\/api\/admin\/users\/(u_[a-z0-9]+)\/gifts\/(gf_[a-z0-9]{6,20})\/mail$/);
    if (gm) {
      // Under waitUntil, like the first send: a tab closed meanwhile cannot cut it off.
      const again = mailGiftAgain(env, adminId, gm[1], gm[2]);
      ctx?.waitUntil(again.catch(() => {}));
      return json(await again);
    }
    if (path === "/api/admin/sources/links") return createLink(env, adminId, await body(request));
    const lm = path.match(/^\/api\/admin\/sources\/links\/([a-z0-9-]{1,40})$/);
    if (lm) return changeLink(env, adminId, lm[1], await body(request));
    if (path === "/api/admin/emails/mode") return emailSwitch(env, request, gate, adminId, await body(request));
    if (path === "/api/admin/emails/test") return json(await sendSeriesToOwner(env, livePrices(env)));
    if (path === "/api/admin/emails/suppress") return emailSuppress(env, adminId, await body(request));
    if (path === "/api/admin/emails/receipts") {
      const on = (await body(request)).on === true;
      await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES ('receipts_mode', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? "on" : "off").run();
      await audit(asEnv(env), adminId, null, "admin.receipts_mode", { on });
      return json({ ok: true, on });
    }
    if (path.startsWith("/api/admin/outreach/")) return outreachRoute(env, request, gate, adminId, path, await body(request));
    const pm = path.match(/^\/api\/admin\/creators\/posts\/(cp_[a-z0-9]+)$/);
    if (pm) return json(await adminPostAction(env, adminId, pm[1], await body(request)));
    const ca = path.match(/^\/api\/admin\/creators\/(u_[a-z0-9]+)\/(bio|approve|refuse|level|end|ban|reopen|note|credits|payout)$/);
    if (ca) {
      const b = await body(request);
      // A ban takes credits and money back, and a payout says money left: both want a code typed in the last 5 minutes.
      if ((ca[2] === "ban" || ca[2] === "payout") && !isFresh(gate.session)) await freshGate(env, request, gate, adminId, b);
      return json(await adminCreatorAction(env, adminId, ca[1], ca[2], b, ca[2] === "bio" || ca[2] === "note" ? String(b.reason ?? "").trim() || ca[2] : reasonOf(b)));
    }
    const km = path.match(/^\/api\/admin\/keys\/([A-Z0-9_]{3,64})(?:\/(test|revert))?$/);
    if (km) return keyRoute(env, request, gate, adminId, km[1], (km[2] ?? "set") as "set" | "revert" | "test");
  }
  return json({ error: "Not found." }, 404);
}

// ── the welcome e-mails (src/studio/onboarding.ts) ─────────────────────────────────────────────────────────────

const MAIL_NAMES: Record<MailKey, string> = {
  "w0-welcome": "Day 1 · Welcome", "w1-templates": "Day 2 · Templates", "w2-prompts": "Day 3 · Prompts", "w3-apps": "Day 4 · Apps",
  "w4-share": "Day 5 · Sizes and sharing", "w5-credits": "Day 6 · Credits", "w6-founder": "Day 7 · Founder's question",
  rescue: "Rescue · first try failed", "c0-failed": "Comeback · first try failed", "c0-unused": "Comeback · nothing made yet",
  "c0-next": "Comeback · made something", "c1-founder": "Comeback · founder's question",
};
/** The sample account each preview is written for: a new one, one that failed, one that made something. */
const sampleFor = (k: MailKey) => sampleFacts(k === "c0-next" ? { made: 2, credits: 1 } : k === "c0-failed" || k === "rescue" ? { failed: 1 } : {});

async function emails(env: StudioEnv): Promise<unknown> {
  const mode = await mailMode(env);
  const q = async <T>(sql: string, ...a: unknown[]): Promise<T[]> => ((await env.DB.prepare(sql).bind(...a).all<T>()).results ?? []);
  const one = async (sql: string, ...a: unknown[]): Promise<number> => Number((await env.DB.prepare(sql).bind(...a).first<{ n: number }>())?.n ?? 0);
  const [series, today, week, total, failures, unsub, bounced, paidAfter, upcoming, recent] = await Promise.all([
    q<{ track: string; status: string; n: number }>("SELECT track, status, COUNT(*) AS n FROM studio_mail GROUP BY track, status"),
    one(`SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 1 AND at >= ${TODAY}`),
    one(`SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 1 AND at >= ${ago(7)}`),
    one("SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 1"),
    one(`SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 0 AND at >= ${ago(7)}`),
    one("SELECT COUNT(*) AS n FROM mail_suppress WHERE reason = 'unsubscribe'"),
    one("SELECT COUNT(*) AS n FROM mail_suppress WHERE reason = 'bounce'"),
    one("SELECT COUNT(DISTINCT m.user_id) AS n FROM studio_mail m JOIN payments p ON p.user_id = m.user_id AND p.status = 'paid' AND p.amount_cent > 0 AND p.at >= m.started_at"),
    q<{ user_id: string; email: string; track: "welcome" | "comeback"; step: number; next_at: string }>("SELECT user_id, email, track, step, next_at FROM studio_mail WHERE status = 'active' ORDER BY next_at LIMIT 20"),
    q<{ user_id: string | null; email: string; mail: MailKey; kind: string; ok: number; error: string | null; at: string }>("SELECT user_id, email, mail, kind, ok, error, at FROM studio_mail_log ORDER BY id DESC LIMIT 40"),
  ]);
  // Before the first switch-on: who the comeback e-mail would reach, and which one each would get.
  let comeback: { total: number; byMail: Record<string, number> } | null = null;
  if (!mode.since) {
    const admins = (env.STUDIO_ADMINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const ids = await q<{ id: string }>(`SELECT u.id FROM users u WHERE u.created_at >= ${ago(30)}
      AND EXISTS (SELECT 1 FROM studio_logins l WHERE l.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_cent > 0)
      ${admins.length ? `AND u.id NOT IN (${admins.map(() => "?").join(",")})` : ""}`, ...admins);
    const byMail: Record<string, number> = {};
    let n = 0;
    for (const { id } of ids) {
      const f = await factsOf(env, id);
      if (!f?.email || f.closed) continue;
      if (await env.DB.prepare("SELECT 1 AS one FROM mail_suppress WHERE email = ?").bind(f.email.toLowerCase()).first()) continue;
      const k = MAIL_NAMES[comebackMail(f)];
      byMail[k] = (byMail[k] ?? 0) + 1;
      n++;
    }
    comeback = { total: n, byMail };
  }
  const nextName = (r: { track: "welcome" | "comeback"; step: number }): string => {
    const m = SERIES[r.track]?.[r.step]?.mail;
    return m === "c0" ? "Comeback · the one that fits" : m ? MAIL_NAMES[m] : "—";
  };
  const counts = { active: 0, done: 0, stopped: 0, welcome: 0, comeback: 0 };
  for (const r of series) {
    counts[r.track === "comeback" ? "comeback" : "welcome"] += r.n;
    if (r.status === "active" || r.status === "done" || r.status === "stopped") counts[r.status] += r.n;
  }
  const prices = livePrices(env);
  const nameOf = (mail: string): string => MAIL_NAMES[mail as MailKey] ?? RECEIPT_KINDS.find((k) => k.key === mail)?.name ?? (mail === "gift" ? GIFT_MAIL_NAME : mail);
  return {
    on: mode.on, since: mode.since, from: "Leonardo from Kleo <hello@kleooai.com>", dailyCap: Number(env.STUDIO_MAIL_DAILY_CAP ?? 300),
    counts, sent: { today, week, total }, failures, unsubscribed: unsub, bounced, paidAfter, comeback,
    upcoming: upcoming.map((r) => ({ ...r, mail: nextName(r) })),
    recent: recent.map((r) => ({ ...r, name: nameOf(r.mail) })),
    mails: [...ALL_MAILS.map((k) => ({ key: k, name: MAIL_NAMES[k], subject: compose(k, sampleFor(k), prices).subject })),
      ...RECEIPT_KINDS.map((r) => ({ key: r.key, name: r.name, subject: composeReceipt(r.kind, sampleReceipt(r.kind)).subject })),
      // The gift e-mail (src/studio/gifts.ts), as a sample account gets it.
      { key: "gift", name: GIFT_MAIL_NAME, subject: composeGift(sampleGift()).subject }],
    receipts: {
      on: await receiptsOn(env),
      sent: Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_receipts WHERE ok = 1").first<{ n: number }>())?.n ?? 0),
      week: Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM studio_receipts WHERE ok = 1 AND at >= ${ago(7)}`).first<{ n: number }>())?.n ?? 0),
    },
  };
}

function emailPreview(env: StudioEnv, url: URL): unknown {
  const rk = RECEIPT_KINDS.find((r) => r.key === url.searchParams.get("key"));
  if (rk) {
    const m = composeReceipt(rk.kind, sampleReceipt(rk.kind));
    return { key: rk.key, name: rk.name, subject: m.subject, preheader: m.preheader, html: renderHtml(m, null), text: renderText(m, null) };
  }
  const stop = "https://app.kleooai.com/email/stop?u=u_preview&s=preview";
  if (url.searchParams.get("key") === "gift") {
    const g = composeGift(sampleGift());
    return { key: "gift", name: GIFT_MAIL_NAME, subject: g.subject, preheader: g.preheader, html: renderHtml(g, stop), text: renderText(g, stop) };
  }
  const key = url.searchParams.get("key") as MailKey;
  if (!ALL_MAILS.includes(key)) throw new StudioError("No such e-mail.", 404, "not_found");
  const m = compose(key, sampleFor(key), livePrices(env));
  return { key, name: MAIL_NAMES[key], subject: m.subject, preheader: m.preheader, html: renderHtml(m, stop), text: renderText(m, stop) };
}

/** Switching on writes to real people: a code from the phone typed in the last 5 minutes. Off needs nothing. */
async function emailSwitch(env: StudioEnv, request: Request, gate: Gate, adminId: string, b: Record<string, unknown>): Promise<Response> {
  const on = b.on === true;
  if (on && !isFresh(gate.session)) {
    if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
    await checkFreshCode(env, request, adminId, b.code);
    gate.fresh = true;
  }
  await setMailMode(env, on, adminId);
  return json({ ok: true, on });
}

/** One address stopped by hand (or allowed again): whatever wrote to it, welcome e-mails or outreach. */
async function emailSuppress(env: StudioEnv, adminId: string, b: Record<string, unknown>): Promise<Response> {
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) throw new StudioError("That doesn't look like an e-mail address.", 400, "email");
  if (b.on === false) await env.DB.prepare("DELETE FROM mail_suppress WHERE email = ?").bind(email).run();
  else {
    await env.DB.prepare("INSERT OR IGNORE INTO mail_suppress (email, reason, source) VALUES (?, 'manual', 'admin')").bind(email).run();
    await env.DB.prepare(`UPDATE studio_mail SET status = 'stopped', stop_reason = 'manual', updated_at = ${NOW} WHERE email = ? AND status = 'active'`).bind(email).run();
  }
  await audit(asEnv(env), adminId, null, "admin.mail_suppress", { domain: email.split("@")[1], on: b.on !== false });
  return json({ ok: true });
}

// ── outreach (src/studio/outreach.ts) ───────────────────────────────────────────────────────────────────────────

/** A fresh code for what writes to strangers or changes the mailbox password; reads and approvals need none. */
async function freshGate(env: StudioEnv, request: Request, gate: Gate, adminId: string, b: Record<string, unknown>): Promise<void> {
  if (gate.fresh || isFresh(gate.session)) return;
  if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
  await checkFreshCode(env, request, adminId, b.code);
  gate.fresh = true;
}

async function outreachRoute(env: StudioEnv, request: Request, gate: Gate, adminId: string, path: string, b: Record<string, unknown>): Promise<Response> {
  // A mailbox's password, and the settings that write to strangers or spend money, want a fresh code.
  if (path === "/api/admin/outreach/senders") {
    await freshGate(env, request, gate, adminId, b);
    return json(await saveSender(env, adminId, b));
  }
  const sm = path.match(/^\/api\/admin\/outreach\/senders\/(s_[a-z0-9]{4,20})$/);
  if (sm) return json(await senderAction(env, adminId, sm[1], String(b.action ?? "")));
  if (path === "/api/admin/outreach/settings") {
    if (b.scoutOn === true || b.autoApprove === true || (b.trialCredits !== undefined && Number(b.trialCredits) > 50)) await freshGate(env, request, gate, adminId, b);
    return json(await saveSettings(env, adminId, b));
  }
  if (path === "/api/admin/outreach/mode") {
    if (b.on === true) await freshGate(env, request, gate, adminId, b);
    return json(await setOutreachMode(env, adminId, b.on === true));
  }
  if (path === "/api/admin/outreach/test") return json(await sendOutreachTest(env, typeof b.sender === "string" ? b.sender : null, {}, typeof b.to === "string" ? b.to : null, Number(b.step) || 0));
  if (path === "/api/admin/outreach/approve-new") return json(await prospectAction(env, adminId, "", "approve-new"));
  if (path === "/api/admin/outreach/import") {
    const rows = typeof b.csv === "string" ? parseCsv(b.csv) : Array.isArray(b.prospects) ? b.prospects as Record<string, unknown>[] : [];
    if (!rows.length) throw new StudioError("Paste the CSV with a header line first.", 400, "empty");
    const r = await addProspects(env, rows, String(b.batch ?? "console").slice(0, 40) || "console");
    await audit(asEnv(env), adminId, null, "admin.outreach_import", { added: r.added, skipped: r.skipped.length });
    return json(r);
  }
  const pm = path.match(/^\/api\/admin\/outreach\/prospects\/(p_[a-z0-9]{6,20})$/);
  if (pm) return json(await prospectAction(env, adminId, pm[1], String(b.action ?? "")));
  return json({ error: "Not found." }, 404);
}

/** The Keys page's writes (admin-keys.ts): a change or a revert wants a reason and a code typed in the last 5 minutes. */
async function keyRoute(env: StudioEnv, request: Request, gate: Gate, adminId: string, name: string, action: "set" | "revert" | "test"): Promise<Response> {
  const b = await body(request);
  if (action === "test") return keyAction(env, adminId, name, "test", b, "");
  const reason = reasonOf(b);
  if (!isFresh(gate.session)) {
    if (!b.code) throw new StudioError("Type a new code from your phone to do this.", 403, "fresh_code");
    await checkFreshCode(env, request, adminId, b.code);
    gate.fresh = true;
  }
  return keyAction(env, adminId, name, action, b, reason);
}
