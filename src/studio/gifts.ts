/**
 * KLEO STUDIO: A GIFT FROM THE KLEO TEAM (30 October 2026). The owner wanted to thank his best paying customer with a
 * surprise: free credits, a pop-up in the app and an e-mail, then an invitation to Kleo Creators. It works for any account.
 *
 * THE CONSOLE (src/studio/admin.ts: Users, one account, Actions, "Gift credits": credits, reason, optional message and the
 * "E-mail them" switch) puts the credits in at once through the same audited path as "Add credits" (admin.ts
 * moveCredits: one admin.credits audit row, the CREDITS_WITHOUT_CODE rule, the fresh code), and writes the gift's row in
 * the same batch, only when that audit row was written (giftRow): a change refused for want of a code leaves no gift.
 *
 *   studio_gifts   one row per gift: the credits, the reason (the audit log's, never shown to the person), the message the
 *                  person reads (optional), the admin who sent it, the e-mail asked for and what came of it, and when the
 *                  app showed it (seen_at; NULL = the next load shows it)
 *
 * THE APP (studio-web/app.js giftModal) reads the gifts not shown yet in /api/me ("gift": their ids, their credits added
 * up, the newest message) and shows them once, on its next load after sign-in: "A gift from the Kleo team", X and Claim
 * only close it, since the credits are in already. It tells the server at once (POST /api/me/gift/seen), so a reload, a
 * second tab or the phone never shows it again. Then, for an account with no creators row, "Become a Kleo Creator".
 *
 * THE E-MAIL, when asked for, goes out at once through the welcome e-mails' sending (onboarding.ts deliver, from
 * hello@kleooai.com, with the stop link): the gift, then one line inviting the person to Kleo Creators, left out for an
 * account already in the program. An address on the stop list (unsubscribed or bounced, mail_suppress) gets nothing and
 * the console says so; the pop-up still shows. Every send is a studio_mail_log row (mail and kind "gift").
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { audit } from "../db.ts";
import { StudioError } from "./generate.ts";
import { COMMISSION_MONTHS, LEVELS } from "./creators.ts";
import { deliver, factsOf, stopLink, type Mail } from "./onboarding.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const APP = "https://app.kleooai.com";

/** The longest message a gift carries: a sentence or two, read in a pop-up. */
export const GIFT_MESSAGE_MAX = 280;
/** The name the console's Emails page gives the gift e-mail. */
export const GIFT_MAIL_NAME = "Gift · from the Kleo team";
const GIFT_ID = /^gf_[a-z0-9]{6,20}$/;

/** The message as the person reads it: one paragraph, no control characters; null when there is none. */
export function giftMessage(raw: unknown): string | null {
  const m = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return null;
  if (m.length > GIFT_MESSAGE_MAX) throw new StudioError(`Keep the message to ${GIFT_MESSAGE_MAX} characters.`, 400, "gift_message");
  return m;
}

/** "1 free credit", "20 free credits". */
export const freeCredits = (n: number): string => `${n} free credit${n === 1 ? "" : "s"}`;

/**
 * The gift's row, written in the credit change's own batch (admin.ts moveCredits) and only when that change wrote its
 * admin.credits audit row for this gift.
 */
export function giftRow(env: StudioEnv, g: { id: string; userId: string; credits: number; reason: string; message: string | null; adminId: string; mail: boolean }): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO studio_gifts (id, user_id, credits, reason, message, by_admin, mail)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM audit a WHERE a.user_id = ?2 AND a.event = 'admin.credits' AND json_extract(a.detail, '$.gift') = ?1)`)
    .bind(g.id, g.userId, g.credits, g.reason, g.message, g.adminId, g.mail ? 1 : 0);
}

// ── the app's side ───────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingGift { ids: string[]; credits: number; message: string | null }

/** The gifts the app has not shown yet, as one: their ids, their credits added up, the newest message. */
export async function pendingGift(env: StudioEnv, userId: string): Promise<PendingGift | null> {
  const rows = (await env.DB.prepare("SELECT id, credits, message FROM studio_gifts WHERE user_id = ? AND seen_at IS NULL ORDER BY created_at, rowid LIMIT 20")
    .bind(userId).all<{ id: string; credits: number; message: string | null }>()).results ?? [];
  if (!rows.length) return null;
  return {
    ids: rows.map((r) => r.id),
    credits: rows.reduce((a, r) => a + (Number(r.credits) || 0), 0),
    message: rows.map((r) => r.message).filter((m): m is string => !!m).pop() ?? null,
  };
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
export async function giftsOf(env: StudioEnv, userId: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(`SELECT id, credits, reason, message, by_admin, mail, mail_status, mail_to, mail_error, mailed_at, created_at, seen_at
      FROM studio_gifts WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`).bind(userId).all<Record<string, unknown>>()).results ?? [];
}

// ── the e-mail ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface GiftFacts {
  name: string | null;
  credits: number;
  /** The balance with the gift in. */
  balance: number;
  message: string | null;
  /** The account has a creators row: no invitation to Kleo Creators. */
  creator: boolean;
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
      ...(f.creator ? [] : [{ p: `One more thing: you're invited to Kleo Creators, with ${LEVELS.creator.rateBp / 100}% of every sale from your link for ${COMMISSION_MONTHS} months and bonus credits for your views. Apply at [app.kleooai.com/creators](${link("/creators", "gift-creators")}).` }]),
      { p: "Leonardo and the Kleo team" },
    ],
  };
}

/** A believable gift for the console's preview and the owner's test send. */
export const sampleGift = (): GiftFacts => ({ name: "Alex", credits: 20, balance: 34, message: null, creator: false });

export interface GiftMail { status: "sent" | "failed" | "skipped"; to: string | null; error: string | null }

/** Sends one gift's e-mail now and writes on the gift what came of it. Never throws for a refusal: it is the answer. */
export async function mailGift(env: StudioEnv, userId: string, giftId: string): Promise<GiftMail> {
  const done = async (status: GiftMail["status"], to: string | null, error: string | null): Promise<GiftMail> => {
    await env.DB.prepare(`UPDATE studio_gifts SET mail_status = ?, mail_to = ?, mail_error = ?, mailed_at = ${NOW} WHERE id = ?`).bind(status, to, error, giftId).run();
    return { status, to, error };
  };
  const g = await env.DB.prepare("SELECT credits, message FROM studio_gifts WHERE id = ? AND user_id = ?").bind(giftId, userId).first<{ credits: number; message: string | null }>();
  const f = await factsOf(env, userId);
  if (!g || !f) return done("skipped", null, "The gift or the account is gone.");
  if (!f.email) return done("skipped", null, "This account has no e-mail address on record.");
  if (f.closed) return done("skipped", f.email, `This account is ${f.closed}.`);
  const stop = await env.DB.prepare("SELECT reason FROM mail_suppress WHERE email = ?").bind(f.email.toLowerCase()).first<{ reason: string }>();
  if (stop) {
    return done("skipped", f.email, stop.reason === "unsubscribe" ? "This address unsubscribed from Kleo's e-mails."
      : stop.reason === "bounce" ? "E-mail to this address bounced before." : "This address is on the stop list.");
  }
  const creator = !!(await env.DB.prepare("SELECT 1 AS one FROM creators WHERE user_id = ?").bind(userId).first().catch(() => null));
  const m = composeGift({ name: f.name, credits: Number(g.credits) || 0, balance: f.credits, message: g.message, creator });
  const r = await deliver(env, f.email, m, await stopLink(env, userId), "gift");
  await env.DB.prepare("INSERT INTO studio_mail_log (user_id, email, mail, kind, ok, error, message_id) VALUES (?, ?, 'gift', 'gift', ?, ?, ?)")
    .bind(userId, f.email, r.ok ? 1 : 0, r.ok ? null : `${r.code}: ${r.error}`, r.ok ? r.id : null).run();
  return r.ok ? done("sent", f.email, null) : done("failed", f.email, `${r.code}: ${r.error}`);
}
