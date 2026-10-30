/**
 * KLEO STUDIO: A GIFT FROM THE KLEO TEAM (30 October 2026). The owner wanted to thank his best paying customer with a
 * surprise: free credits, a pop-up in the app and an e-mail, then an invitation to Kleo Creators. It works for any account
 * a person can open in the app (an assistant-only account is refused: its gift would be lost when it signs in).
 *
 * THE CONSOLE (src/studio/admin.ts: Users, one account, Actions, "Gift credits": credits, reason, optional message and the
 * "E-mail them" switch) puts the credits in at once through the same audited path as "Add credits" (admin.ts
 * moveCredits: one admin.credits audit row, the CREDITS_WITHOUT_CODE rule, the fresh code). The gift's id is made once
 * per sheet by the console: the gift's row goes FIRST in the credit change's batch (giftInsert), and an id already used
 * stops the whole batch, so a second click, or a request sent again after its answer was lost, never gives twice.
 *
 *   studio_gifts   one row per gift: the credits, the reason (the audit log's, never shown to the person), the message the
 *                  person reads (optional), the admin who sent it, the e-mail asked for and what came of it, and when the
 *                  app showed it (seen_at; NULL = the next load shows it)
 *
 * THE APP (studio-web/app.js giftModal) reads the gifts not shown yet in /api/me ("gift": each one's id, credits and
 * message, and their total) and shows the ones this page has not shown yet, once: "A gift from the Kleo team", X and
 * Claim only close it, since the credits are in already. It tells the server at once (POST /api/me/gift/seen), so a
 * reload, a second tab or the phone never shows it again. Then, for an account that has paid and has no creators row,
 * "Become a Kleo Creator".
 *
 * THE E-MAIL, when asked for, goes out at once through the welcome e-mails' sending (onboarding.ts deliver, from
 * hello@kleooai.com, with the stop link), to the address the console's sheet shows (giftAddress): the gift, then, for
 * the same accounts as the app's card, one line inviting the person to Kleo Creators. Each send first claims the gift
 * (mail_status 'sending'), so it goes out at most once. An address on the stop list (unsubscribed or bounced) gets
 * nothing; a refusal of the address itself is 'failed'; anything else Kleo's side may get past later (rate, quota, the
 * sending domain) leaves it 'waiting', and the console's "Send the e-mail again" tries once more. Every send is a
 * studio_mail_log row (mail and kind "gift"), written after the outcome, best effort.
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit, hasPaid } from "../db.ts";
import { StudioError, isAdmin } from "./generate.ts";
import { COMMISSION_MONTHS, LEVELS } from "./creators.ts";
import { ADDRESS_PROBLEM, deliver, factsOf, stopLink, type Facts, type Mail } from "./onboarding.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const APP = "https://app.kleooai.com";

/** The longest message a gift carries: a sentence or two, read in a pop-up. */
export const GIFT_MESSAGE_MAX = 280;
/** The name the console's Emails page gives the gift e-mail. */
export const GIFT_MAIL_NAME = "Gift · from the Kleo team";
/** A gift's id, as rid("gf", 12) and the console's sheet make it. */
export const GIFT_ID = /^gf_[a-z0-9]{6,20}$/;

/** The message as the person reads it: one paragraph, no control characters; null when there is none. */
export function giftMessage(raw: unknown): string | null {
  const m = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return null;
  if (m.length > GIFT_MESSAGE_MAX) throw new StudioError(`Keep the message to ${GIFT_MESSAGE_MAX} characters.`, 400, "gift_message");
  return m;
}

/** "1 free credit", "20 free credits". */
export const freeCredits = (n: number): string => `${n} free credit${n === 1 ? "" : "s"}`;

export interface GiftDraft { id: string; userId: string; credits: number; reason: string; message: string | null; adminId: string; mail: boolean }

/**
 * The gift's row, the FIRST statement of the credit change's batch (admin.ts moveCredits). A plain INSERT: an id that is
 * already there fails it, and D1 then rolls the whole batch back, credits and audit row included. `cond` (with its
 * `args`) is the condition the rest of the batch moves on, so the row is written exactly when the credits move.
 */
export function giftInsert(env: StudioEnv, g: GiftDraft, cond = "1", args: unknown[] = []): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO studio_gifts (id, user_id, credits, reason, message, by_admin, mail) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${cond}`)
    .bind(g.id, g.userId, g.credits, g.reason, g.message, g.adminId, g.mail ? 1 : 0, ...args);
}

export interface GiftRow {
  id: string; user_id: string; credits: number; reason: string; message: string | null; by_admin: string; mail: number;
  mail_status: string | null; mail_to: string | null; mail_error: string | null; mailed_at: string | null; created_at: string; seen_at: string | null;
}
export const giftById = (env: StudioEnv, id: string) => env.DB.prepare("SELECT * FROM studio_gifts WHERE id = ?").bind(id).first<GiftRow>();

// ── the app's side ───────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingGift { items: { id: string; credits: number; message: string | null }[]; credits: number }

/** The gifts the app has not shown yet, oldest first, and their credits added up. */
export async function pendingGift(env: StudioEnv, userId: string): Promise<PendingGift | null> {
  const rows = (await env.DB.prepare("SELECT id, credits, message FROM studio_gifts WHERE user_id = ? AND seen_at IS NULL ORDER BY created_at, rowid LIMIT 20")
    .bind(userId).all<{ id: string; credits: number; message: string | null }>()).results ?? [];
  if (!rows.length) return null;
  const items = rows.map((r) => ({ id: r.id, credits: Number(r.credits) || 0, message: r.message ?? null }));
  return { items, credits: items.reduce((a, r) => a + r.credits, 0) };
}

/** The app showed these gifts: they never show again, on any device. Only the account's own; answers how many. */
export async function markGiftsSeen(env: StudioEnv, userId: string, raw: unknown): Promise<number> {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string" && GIFT_ID.test(x)))].slice(0, 20);
  if (!ids.length) return 0;
  const r = await env.DB.prepare(`UPDATE studio_gifts SET seen_at = ${NOW} WHERE user_id = ? AND seen_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids).run();
  const n = Number(r.meta?.changes ?? 0);
  if (n) await audit(asEnv(env), userId, null, "gift.seen", { gifts: ids, seen: n });
  return n;
}

/** Every gift of one account, newest first, for the console's account page. */
export async function giftsOf(env: StudioEnv, userId: string): Promise<GiftRow[]> {
  return (await env.DB.prepare("SELECT * FROM studio_gifts WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(userId).all<GiftRow>()).results ?? [];
}

// ── who gets the e-mail, and who is invited ──────────────────────────────────────────────────────────────────────

/**
 * The address a gift's e-mail goes to, the one lookup the console's sheet shows and mailGift uses: the account's own
 * (onboarding.ts factsOf: its sign-in's, its own unless synthetic, the contact one), else the newest payment's, as the
 * payment e-mails do (receipts.ts). Null for none.
 */
export async function giftAddress(env: StudioEnv, userId: string, facts?: Facts | null): Promise<string | null> {
  const f = facts === undefined ? await factsOf(env, userId) : facts;
  if (f?.email) return f.email;
  const p = await env.DB.prepare("SELECT email FROM payments WHERE user_id = ? AND email IS NOT NULL AND email != '' ORDER BY at DESC LIMIT 1").bind(userId).first<{ email: string }>();
  return p?.email ?? null;
}

/**
 * Whether a gift invites the person to Kleo Creators, in the e-mail and in the app alike: the program takes only accounts
 * that have paid (creators.ts applyAsCreator), and not one that already has a place or an application there.
 */
export async function invitesToCreators(env: StudioEnv, userId: string): Promise<boolean> {
  if (await env.DB.prepare("SELECT 1 AS one FROM creators WHERE user_id = ?").bind(userId).first().catch(() => null)) return false;
  return isAdmin(env, userId) || (await hasPaid(asEnv(env), userId));
}

// ── the e-mail ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface GiftFacts {
  name: string | null;
  credits: number;
  /** The balance with the gift in. */
  balance: number;
  message: string | null;
  /** The line inviting the person to Kleo Creators (invitesToCreators). */
  invite: boolean;
}

const link = (path: string, campaign: string): string => `${APP}${path}?utm_source=email&utm_medium=gift&utm_campaign=${campaign}`;

/** The e-mail: the gift, the message, then one line inviting the person to Kleo Creators (the program's own numbers). */
export function composeGift(f: GiftFacts): Mail {
  const one = f.credits === 1;
  return {
    key: "gift",
    subject: `The Kleo team sent you ${freeCredits(f.credits)}`,
    preheader: `${one ? "It's" : "They're"} already in your account. Thanks for creating with Kleo!`,
    blocks: [
      { p: `Hi ${f.name ?? "there"},` },
      { p: `A little gift from all of us at Kleo: **${freeCredits(f.credits)}**. ${one ? "It's" : "They're"} already in your account, so you have ${f.balance} credit${f.balance === 1 ? "" : "s"} now.` },
      ...(f.message ? [{ p: f.message }] : []),
      { p: `Thanks for creating with Kleo, enjoy ${one ? "it" : "them"}!` },
      { button: { label: "Open Kleo", url: link("/", "gift") } },
      ...(f.invite ? [{ p: `One more thing: you're invited to Kleo Creators, with ${LEVELS.creator.rateBp / 100}% of every sale from your link for ${COMMISSION_MONTHS} months and bonus credits for your views. Apply at [app.kleooai.com/creators](${link("/creators", "gift-creators")}).` }] : []),
      { p: "Leonardo and the Kleo team" },
    ],
  };
}

/** A believable gift for the console's preview and the owner's test send. */
export const sampleGift = (): GiftFacts => ({ name: "Alex", credits: 20, balance: 34, message: null, invite: true });

/** What came of a gift's e-mail: sent; skipped (nobody to send it to); failed (the address was refused); waiting. */
export interface GiftMail { status: "sent" | "failed" | "skipped" | "waiting"; to: string | null; error: string | null }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Sends one gift's e-mail now, at most once. The gift is claimed first: its mail_status moves from not sent yet (NULL) or
 * 'waiting' to 'sending' in one compare-and-set, so two sends of one gift can never both go out; null when it was not
 * there to claim (sent, being sent, refused, skipped, or no e-mail asked). The outcome is written as soon as deliver()
 * answers, and nothing after a send can turn it into a failure: the mail log is best effort, and a status that can't be
 * written still answers what happened. Never throws.
 */
export async function mailGift(env: StudioEnv, userId: string, giftId: string): Promise<GiftMail | null> {
  const done = async (status: GiftMail["status"], to: string | null, error: string | null): Promise<GiftMail> => {
    try { await env.DB.prepare(`UPDATE studio_gifts SET mail_status = ?, mail_to = ?, mail_error = ?, mailed_at = ${NOW} WHERE id = ?`).bind(status, to, error, giftId).run(); }
    catch (e) { console.error("gift mail status", giftId, errText(e)); }
    return { status, to, error };
  };
  try {
    const claim = await env.DB.prepare("UPDATE studio_gifts SET mail_status = 'sending' WHERE id = ? AND user_id = ? AND mail = 1 AND (mail_status IS NULL OR mail_status = 'waiting')")
      .bind(giftId, userId).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) return null;
  } catch (e) {
    return { status: "waiting", to: null, error: `The e-mail couldn't start: ${errText(e)}` };
  }
  // Everything before the send: a trouble here sent nothing, so the e-mail waits for "Send the e-mail again".
  let ready: { to: string; mail: Mail; stopUrl: string };
  try {
    const g = await env.DB.prepare("SELECT credits, message FROM studio_gifts WHERE id = ?").bind(giftId).first<{ credits: number; message: string | null }>();
    const f = await factsOf(env, userId);
    if (!g || !f) return done("skipped", null, "The gift or the account is gone.");
    if (f.closed) return done("skipped", null, `This account is ${f.closed}.`);
    const to = await giftAddress(env, userId, f);
    if (!to) return done("skipped", null, "This account has no e-mail address on record.");
    const stop = await env.DB.prepare("SELECT reason FROM mail_suppress WHERE email = ?").bind(to.toLowerCase()).first<{ reason: string }>();
    if (stop) {
      return done("skipped", to, stop.reason === "unsubscribe" ? "This address unsubscribed from Kleo's e-mails."
        : stop.reason === "bounce" ? "E-mail to this address bounced before." : "This address is on the stop list.");
    }
    const mail = composeGift({ name: f.name, credits: Number(g.credits) || 0, balance: f.credits, message: g.message, invite: await invitesToCreators(env, userId) });
    ready = { to, mail, stopUrl: await stopLink(env, userId) };
  } catch (e) {
    return done("waiting", null, `The e-mail couldn't be prepared: ${errText(e)}`);
  }
  const r = await deliver(env, ready.to, ready.mail, ready.stopUrl, "gift");
  const what = r.ok ? null : `${r.code}: ${r.error}`;
  const out = await done(r.ok ? "sent" : ADDRESS_PROBLEM.test(what ?? "") ? "failed" : "waiting", ready.to, what);
  try {
    await env.DB.prepare("INSERT INTO studio_mail_log (user_id, email, mail, kind, ok, error, message_id) VALUES (?, ?, 'gift', 'gift', ?, ?, ?)")
      .bind(userId, ready.to, r.ok ? 1 : 0, what, r.ok ? r.id : null).run();
  } catch (e) { console.error("gift mail log", giftId, errText(e)); }
  return out;
}

/** The console's "Send the e-mail again": only for a gift whose e-mail is waiting (or never started); at most once. */
export async function mailGiftAgain(env: StudioEnv, adminId: string, userId: string, giftId: string): Promise<{ ok: true; mail: GiftMail }> {
  const r = await mailGift(env, userId, giftId);
  if (!r) {
    const g = await giftById(env, giftId);
    if (!g || g.user_id !== userId) throw new StudioError("No such gift on this account.", 404, "not_found");
    throw new StudioError(g.mail_status === "sent" ? "This e-mail went out already." : "This e-mail isn't waiting any more. Reload the page.", 409, "gift_mail_state");
  }
  await audit(asEnv(env), userId, null, "admin.gift_mail", { admin: adminId, gift: giftId, mail: r.status }).catch(() => {});
  return { ok: true, mail: r };
}
