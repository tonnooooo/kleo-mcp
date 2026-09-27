import type { Env } from "./env";
import { audit } from "./db.ts";
import { escapeHtml, html, rid } from "./util.ts";
import { MIN_FILM_SECONDS } from "./templates.ts";

/**
 * REFERRALS (27 September 2026, the owner: "attract people and make them stay"). Every account has a referral code
 * and a link (${PUBLIC_URL}/r/<code>); an account OPENED through it is linked to the referrer (users.referred_by, once,
 * never to itself). When that account makes its FIRST REAL PAYMENT — a Stripe payment with an amount, through the
 * webhook — the referrer gets REFERRER_BONUS credits and the referred REFERRED_BONUS on top of that first pack. Never
 * for grants (a tester row, a launch code, a gift: none of them comes through the webhook), never twice (one
 * `referrals` row per referred account), and a dispute of that payment takes both back (src/stripe.ts).
 *
 * How the link reaches the sign-up: /r/<code> sets a kleo_ref cookie on this host and shows the connector address
 * with ?ref=<code>; the sign-in page (src/auth.ts) reads the cookie, the ref in the connector address the client
 * sends as its OAuth `resource`, or the code typed in its code field; the first MCP call of a new account also
 * carries ?ref= (src/index.ts). Whichever comes first links the account; the rest find it linked.
 */

export const REFERRER_BONUS = 10;
export const REFERRED_BONUS = 5;
export const REF_COOKIE = "kleo_ref";
/** 30 days: long enough for a friend to come back to the link a week later, short enough to mean "sent by". */
const REF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A referral code as typed: "R" and seven letters or digits, upper case; null when it cannot be one. */
export function normalizeReferral(raw: unknown): string | null {
  const c = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^R[A-Z0-9]{7}$/.test(c) ? c : null;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return "R" + [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** The account's referral code, made the first time it is asked for (the UNIQUE index settles a collision: try again). */
export async function referralCodeFor(env: Env, userId: string): Promise<string | null> {
  for (let i = 0; i < 4; i++) {
    const have = await env.DB.prepare("SELECT referral_code FROM users WHERE id = ?").bind(userId).first<{ referral_code: string | null }>();
    if (!have) return null;
    if (have.referral_code) return have.referral_code;
    try {
      await env.DB.prepare("UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL").bind(newCode(), userId).run();
    } catch (e) {
      if (!/unique|constraint/i.test(String(e))) throw e; // another account has that code: draw another one
    }
  }
  return null;
}

/** The link a user shares: a page on this server that remembers the code and shows how to add Kleo. */
export const referralLink = (base: string, code: string): string => `${base}/r/${code}`;

/** The rule in one sentence, for the tools and the pages. */
export const referralRule = (): string =>
  `when someone who joined through your link buys their first credit pack, you get ${REFERRER_BONUS} credits and they get ${REFERRED_BONUS} more on top of their pack`;

export const referrerOf = (env: Env, code: string) =>
  env.DB.prepare("SELECT id FROM users WHERE referral_code = ?").bind(code).first<{ id: string }>();

/**
 * Links a new account to the account whose code it arrived with. Once (referred_by is written only while empty), never
 * to itself, never to a code nobody has. Returns true when THIS call linked it.
 */
export async function linkReferral(env: Env, userId: string, raw: unknown, via: string): Promise<boolean> {
  const code = normalizeReferral(raw);
  if (!code) return false;
  const referrer = await referrerOf(env, code);
  if (!referrer || referrer.id === userId) return false;
  const r = await env.DB.prepare("UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL AND id != ?").bind(referrer.id, userId, referrer.id).run();
  if ((r.meta.changes ?? 0) !== 1) return false;
  await audit(env, userId, null, "referral.linked", { referrer: referrer.id, code, via });
  return true;
}

/**
 * The reward, called by the Stripe webhook right after a payment was credited for the first time (creditPurchase said
 * so). One batch: the `referrals` row is written only for an account that has a referrer and no OTHER payment with an
 * amount (this is its first real one); its primary key refuses a second row; both credits follow only if THAT row (its
 * nonce) exists. Returns what was given, or null.
 */
export async function rewardReferral(env: Env, userId: string, sessionId: string): Promise<{ referrer: string; referrer_credits: number; referred_credits: number } | null> {
  const nonce = rid("rf", 12);
  const rows = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO referrals (referred_id, referrer_id, session_id, referrer_credits, referred_credits, nonce)
       SELECT u.id, u.referred_by, ?, ?, ?, ? FROM users u
       WHERE u.id = ? AND u.referred_by IS NOT NULL AND u.referred_by != u.id
         AND EXISTS (SELECT 1 FROM users r WHERE r.id = u.referred_by)
         AND EXISTS (SELECT 1 FROM payments WHERE session_id = ? AND user_id = u.id AND amount_cent > 0 AND status = 'paid')
         AND NOT EXISTS (SELECT 1 FROM payments WHERE user_id = u.id AND amount_cent > 0 AND session_id != ?)`,
    ).bind(sessionId, REFERRER_BONUS, REFERRED_BONUS, nonce, userId, sessionId, sessionId),
    env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = (SELECT referrer_id FROM referrals WHERE referred_id = ? AND nonce = ?)")
      .bind(REFERRER_BONUS, userId, nonce),
    env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ? AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND nonce = ?)")
      .bind(REFERRED_BONUS, userId, userId, nonce),
  ]);
  if ((rows[0]?.meta.changes ?? 0) !== 1) return null;
  const row = await env.DB.prepare("SELECT referrer_id FROM referrals WHERE referred_id = ?").bind(userId).first<{ referrer_id: string }>();
  const referrer = row?.referrer_id ?? "";
  await audit(env, referrer, null, "referral.rewarded", { referred: userId, session: sessionId, amount: REFERRER_BONUS, role: "referrer" });
  await audit(env, userId, null, "referral.rewarded", { referrer, session: sessionId, amount: REFERRED_BONUS, role: "referred" });
  return { referrer, referrer_credits: REFERRER_BONUS, referred_credits: REFERRED_BONUS };
}

/**
 * A dispute of the payment that earned a reward takes the reward back from both sides (the balance may go negative,
 * like takeBackCredits: the money is gone). Once: the row's status moves from paid to disputed in the same batch.
 */
export async function takeBackReferral(env: Env, sessionId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM referrals WHERE session_id = ? AND status = 'paid'").bind(sessionId)
    .first<{ referred_id: string; referrer_id: string; referrer_credits: number; referred_credits: number; nonce: string }>();
  if (!row) return false;
  const rows = await env.DB.batch([
    env.DB.prepare("UPDATE referrals SET status = 'disputed' WHERE referred_id = ? AND status = 'paid'").bind(row.referred_id),
    env.DB.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND status = 'disputed' AND nonce = ?)")
      .bind(row.referrer_credits, row.referrer_id, row.referred_id, row.nonce),
    env.DB.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND EXISTS (SELECT 1 FROM referrals WHERE referred_id = ? AND status = 'disputed' AND nonce = ?)")
      .bind(row.referred_credits, row.referred_id, row.referred_id, row.nonce),
  ]);
  if ((rows[0]?.meta.changes ?? 0) !== 1) return false;
  await audit(env, row.referred_id, null, "referral.disputed", { referrer: row.referrer_id, session: sessionId, taken: row.referrer_credits + row.referred_credits });
  return true;
}

/** Set-Cookie for the referral a visitor arrived with (read by the sign-in page, src/auth.ts). */
export const referralCookie = (code: string): string =>
  `${REF_COOKIE}=${code}; Path=/; Max-Age=${REF_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;

/** The kleo_ref value out of a Cookie header, or null. */
export function cookieReferral(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === REF_COOKIE) return normalizeReferral(part.slice(eq + 1));
  }
  return null;
}

/**
 * GET /r/<code> — the page a referral link opens: what Kleo is, the connector address carrying the code, and what the
 * friend gets. It remembers the code in a cookie for the sign-in page. An unknown code shows the same page without it.
 */
export async function handleReferralPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = normalizeReferral(decodeURIComponent(url.pathname.slice("/r/".length)));
  const known = code ? !!(await referrerOf(env, code)) : false;
  const base = env.PUBLIC_URL || url.origin;
  const mcp = `${base}/mcp${known ? `?ref=${code}` : ""}`;
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kleo invitation</title><meta name="robots" content="noindex">
<style>
:root{color-scheme:dark;--bg:#0F1216;--bg2:#151920;--line:#262C36;--ink:#ECEAE4;--mute:#838B99;--amber:#F3B53F}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 "Instrument Sans","Helvetica Neue",Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px 16px}
.card{width:min(480px,100%);background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.45rem;margin:0 0 8px}p,li{color:var(--mute);font-size:.95rem}ol{padding-left:20px}
code{display:block;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:.85rem/1.5 monospace;word-break:break-all;color:var(--ink);margin:6px 0 14px}
a{color:var(--amber)}
</style></head><body><main class="card">
<h1>${known ? "A friend invited you to Kleo" : "Kleo"}</h1>
<p>Kleo makes narrated films and Shorts, 4K 60 fps, from a sentence you give your AI assistant (Claude, ChatGPT, Cursor and others that take a connector).</p>
<ol>
<li>In your assistant, add a custom connector with this address:<code>${escapeHtml(mcp)}</code></li>
<li>Press "Start free" on the page that opens: no email, no password, no card. You get a short animatic free, and the smallest pack (5 EUR) is a ${MIN_FILM_SECONDS}-second film.</li>
${known ? `<li>When you buy your first credit pack, you get ${REFERRED_BONUS} extra credits, and your friend gets ${REFERRER_BONUS}.</li>` : ""}
</ol>
<p><a href="https://kleooai.com">kleooai.com</a></p>
</main></body></html>`;
  const res = html(page, known ? 200 : 404);
  if (known && code) res.headers.append("set-cookie", referralCookie(code));
  return res;
}
